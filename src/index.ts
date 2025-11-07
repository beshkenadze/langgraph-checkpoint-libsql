import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  copyCheckpoint,
  maxChannelVersion,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
} from "@langchain/langgraph-checkpoint";
import { type Client, createClient, type Row } from "@libsql/client";

interface CheckpointRow extends Row {
  checkpoint: string | ArrayBuffer;
  metadata: string | ArrayBuffer;
  parent_checkpoint_id: string | null;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string | null;
  type: string | null;
  pending_writes: string | ArrayBuffer;
}

interface PendingWriteColumn {
  task_id: string;
  channel: string;
  type: string;
  value: string;
}

interface PendingSendColumn {
  type: string;
  value: string;
}

interface MigrationRow extends Row {
  pending_sends: string | ArrayBuffer;
}

const checkpointMetadataKeys = ["source", "step", "parents"] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T,
]
  ? [keyof T] extends [K[number]]
    ? K
    : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>
): K {
  return keys;
}

const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

function blobToString(val: string | ArrayBuffer | undefined): string {
  if (val instanceof ArrayBuffer) {
    return Buffer.from(val).toString("utf-8");
  }
  if (typeof val === "string") {
    return val;
  }
  return "";
}

export class SqliteSaver extends BaseCheckpointSaver {
  db: Client;

  protected isSetup: boolean;

  constructor(db: Client, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
    this.isSetup = false;
  }

  static fromConnString(connStringOrLocalPath: string): SqliteSaver {
    return new SqliteSaver(createClient({ url: connStringOrLocalPath }));
  }

  protected async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    try {
      await this.db.execute("PRAGMA journal_mode=WAL");
    } catch {
      // WAL mode may not be supported in all environments
    }

    await this.db.execute(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);

    await this.db.execute(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.setup();
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    const args = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);

    const sql = `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${
    checkpoint_id
      ? "AND checkpoint_id = ?"
      : "ORDER BY checkpoint_id DESC LIMIT 1"
  }`;

    const result = await this.db.execute({ sql, args });
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as CheckpointRow;

    let finalConfig = config;

    if (!checkpoint_id) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error("Missing thread_id or checkpoint_id");
    }

    const pendingWrites = await Promise.all(
      (
        JSON.parse(blobToString(row.pending_writes)) as PendingWriteColumn[]
      ).map(async (write) => {
        return [
          write.task_id,
          write.channel,
          await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
        ] as [string, string, unknown];
      })
    );

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      blobToString(row.checkpoint)
    )) as Checkpoint;

    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id
      );
    }

    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(
        row.type ?? "json",
        blobToString(row.metadata)
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    await this.setup();
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;
    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT
            json_group_array(
              json_object(
                'task_id', pw.task_id,
                'channel', pw.channel,
                'type', pw.type,
                'value', CAST(pw.value AS TEXT)
              )
            )
          FROM writes as pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) as pending_writes,
        (
          SELECT
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            )
          FROM writes as ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) as pending_sends
      FROM checkpoints\n`;

    const whereClause: string[] = [];

    if (thread_id) {
      whereClause.push("thread_id = ?");
    }

    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClause.push("checkpoint_ns = ?");
    }

    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClause.push("checkpoint_id < ?");
    }

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata)
      )
    );

    whereClause.push(
      ...Object.entries(sanitizedFilter).map(
        ([key]) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`
      )
    );

    if (whereClause.length > 0) {
      sql += `WHERE\n  ${whereClause.join(" AND\n  ")}\n`;
    }

    sql += "\nORDER BY checkpoint_id DESC";

    if (limit) {
      const limitNum =
        typeof limit === "string" ? Number.parseInt(limit, 10) : limit;
      sql += ` LIMIT ${limitNum}`;
    }

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
    ].filter((value) => value !== undefined && value !== null);

    const result = await this.db.execute({ sql, args });
    const rows = result.rows as CheckpointRow[];

    if (rows) {
      for (const row of rows) {
        const pendingWrites = await Promise.all(
          (
            JSON.parse(blobToString(row.pending_writes)) as PendingWriteColumn[]
          ).map(async (write) => {
            return [
              write.task_id,
              write.channel,
              await this.serde.loadsTyped(
                write.type ?? "json",
                write.value ?? ""
              ),
            ] as [string, string, unknown];
          })
        );

        const checkpoint = (await this.serde.loadsTyped(
          row.type ?? "json",
          blobToString(row.checkpoint)
        )) as Checkpoint;

        if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
          await this.migratePendingSends(
            checkpoint,
            row.thread_id,
            row.parent_checkpoint_id
          );
        }

        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id,
            },
          },
          checkpoint,
          metadata: (await this.serde.loadsTyped(
            row.type ?? "json",
            blobToString(row.metadata)
          )) as CheckpointMetadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id: row.thread_id,
                  checkpoint_ns: row.checkpoint_ns,
                  checkpoint_id: row.parent_checkpoint_id,
                },
              }
            : undefined,
          pendingWrites,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`
      );
    }

    const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type."
      );
    }

    const args = [
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id ?? null,
      type1,
      serializedCheckpoint,
      serializedMetadata,
    ];

    await this.db.execute({
      sql: `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args,
    });

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const statements = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return {
          sql: `
      INSERT OR REPLACE INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
          args: [
            config.configurable?.thread_id,
            config.configurable?.checkpoint_ns ?? "",
            config.configurable?.checkpoint_id,
            taskId,
            idx,
            write[0],
            type,
            serializedWrite,
          ],
        };
      })
    );

    await this.db.batch(statements, "write");
  }

  async deleteThread(threadId: string) {
    await this.db.batch(
      [
        {
          sql: `DELETE FROM checkpoints WHERE thread_id = ?`,
          args: [threadId],
        },
        {
          sql: `DELETE FROM writes WHERE thread_id = ?`,
          args: [threadId],
        },
      ],
      "write"
    );
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string
  ) {
    const result = await this.db.execute({
      sql: `
          SELECT
            checkpoint_id,
            json_group_array(
              json_object(
                'type', ps.type,
                'value', CAST(ps.value AS TEXT)
              )
            ) as pending_sends
          FROM writes as ps
          WHERE ps.thread_id = ?
            AND ps.checkpoint_id = ?
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        `,
      args: [threadId, parentCheckpointId],
    });

    if (result.rows.length === 0) return;
    const row = result.rows[0] as MigrationRow;

    const mutableCheckpoint = checkpoint;

    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      JSON.parse(blobToString(row.pending_sends)).map(
        ({ type, value }: PendingSendColumn) =>
          this.serde.loadsTyped(type, value)
      )
    );

    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}

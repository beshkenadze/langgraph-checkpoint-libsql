# @langchain/langgraph-checkpoint-libsql

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**LibSQL checkpoint storage for LangGraph.js**

A drop-in replacement for `@langchain/langgraph-checkpoint-sqlite` that uses [LibSQL](https://github.com/tursodatabase/libsql) instead of better-sqlite3, enabling:

- 🚀 **Remote databases** with [Turso](https://turso.tech/)
- 🌐 **Embedded replicas** for offline-first apps
- 🔄 **Automatic sync** between local and remote
- ✨ **Same API** as the SQLite version

## Installation

```bash
npm install @langchain/langgraph-checkpoint-libsql
# or
bun add @langchain/langgraph-checkpoint-libsql
# or
yarn add @langchain/langgraph-checkpoint-libsql
```

## Usage

### Local File Database

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";

// Local SQLite file
const checkpointer = SqliteSaver.fromConnString("file:checkpoints.db");
```

### In-Memory Database

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";

// In-memory database (perfect for testing)
const checkpointer = SqliteSaver.fromConnString(":memory:");
```

### Remote Turso Database

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";
import { createClient } from "@libsql/client";

// Remote Turso database
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const checkpointer = new SqliteSaver(client);
```

### Embedded Replica (Offline-First)

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";
import { createClient } from "@libsql/client";

// Embedded replica with automatic sync
const client = createClient({
  url: "file:local.db",
  syncUrl: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  syncInterval: 60000, // Sync every 60 seconds
});

const checkpointer = new SqliteSaver(client);
```

## Integration with LangGraph

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";
import { StateGraph } from "@langchain/langgraph";

const checkpointer = SqliteSaver.fromConnString("file:checkpoints.db");

const graph = new StateGraph({
  channels: {
    // your state channels
  },
})
  .addNode("step1", async (state) => {
    // your logic
    return state;
  })
  .addEdge("__start__", "step1")
  .compile({ checkpointer });

// Use the graph with persistence
const config = { configurable: { thread_id: "user-123" } };
const result = await graph.invoke({ input: "hello" }, config);
```

## API

### `SqliteSaver.fromConnString(connectionString: string): SqliteSaver`

Create a checkpoint saver from a connection string.

**Connection strings:**
- `":memory:"` - In-memory database
- `"file:path/to/db.db"` - Local file database
- `"libsql://your-database.turso.io"` - Remote LibSQL (requires auth token via constructor)

### `new SqliteSaver(client: Client, serde?: SerializerProtocol)`

Create a checkpoint saver with a LibSQL client.

**Parameters:**
- `client` - LibSQL client instance from `@libsql/client`
- `serde` - Optional custom serializer (defaults to JSON)

### Methods

All methods are identical to `@langchain/langgraph-checkpoint-sqlite`:

- `getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>`
- `list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>`
- `put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig>`
- `putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void>`
- `deleteThread(threadId: string): Promise<void>`

## Migration from SQLite

Simply replace the import and you're done:

```diff
- import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
+ import { SqliteSaver } from "@langchain/langgraph-checkpoint-libsql";

  const checkpointer = SqliteSaver.fromConnString("file:checkpoints.db");
```

No other code changes required! The API is 100% compatible.

## Why LibSQL?

LibSQL is a fork of SQLite that adds:

- **Remote databases** - Host your checkpoints in the cloud with Turso
- **Embedded replicas** - Local-first apps with automatic sync
- **WebSocket support** - Real-time replication
- **100% SQLite compatible** - Same SQL, same data format

## Environment Setup (Turso)

1. Create a Turso database:
   ```bash
   turso db create my-checkpoints
   ```

2. Get your database URL:
   ```bash
   turso db show my-checkpoints --url
   ```

3. Create an auth token:
   ```bash
   turso db tokens create my-checkpoints
   ```

4. Set environment variables:
   ```bash
   export TURSO_DATABASE_URL="libsql://my-checkpoints-xxx.turso.io"
   export TURSO_AUTH_TOKEN="your-auth-token"
   ```

## License

MIT

## Credits

This is a port of [@langchain/langgraph-checkpoint-sqlite](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite) to use LibSQL instead of better-sqlite3.

Original package by LangChain. LibSQL port maintained independently.

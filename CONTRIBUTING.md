# Contributing

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- Node.js >= 18
- Docker (for testing with act)

### Install Dependencies

```bash
bun install
```

### Run Tests

```bash
bun run test
```

### Lint

```bash
bun run lint
```

### Build

```bash
bun run build
```

## Publishing to npm

### Setup npm Token (One-time)

1. **Create npm Access Token:**
   - Log in to [npmjs.com](https://www.npmjs.com/)
   - Go to Account Settings → Access Tokens
   - Generate New Token → Choose "Automation" (for CI/CD)
   - Copy the token (starts with `npm_...`)

2. **Add Token to GitHub Secrets:**
   ```bash
   # Using GitHub CLI
   gh secret set NPM_TOKEN
   # Paste your token when prompted

   # Or manually:
   # Go to: https://github.com/beshkenadze/langgraph-checkpoint-libsql/settings/secrets/actions
   # Click "New repository secret"
   # Name: NPM_TOKEN
   # Value: your_npm_token_here
   ```

3. **Verify Secret is Set:**
   ```bash
   gh secret list
   ```

### Test Workflow Locally with act

**Install act:**

```bash
# macOS
brew install act

# Linux
curl --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash

# Windows
choco install act-cli
```

**Run workflow locally:**

```bash
# Test the entire workflow
act -j test

# Test with secrets (create .secrets file)
echo "NPM_TOKEN=your_test_token" > .secrets
act -j test --secret-file .secrets

# Dry run (list jobs without executing)
act -l

# Test publish job (without actually publishing)
act -j publish --secret-file .secrets
```

**Note:** The `publish` job won't actually publish to npm when running with act locally. To test safely, you can:
1. Comment out the `npm publish` line temporarily
2. Or use `act --dry-run` to see what would happen

### Release Process

1. **Update version in package.json:**
   ```bash
   # Example: bump to 1.0.1
   npm version patch  # or minor, or major
   ```

2. **Commit and push:**
   ```bash
   git add package.json
   git commit -m "chore: bump version to 1.0.1"
   git push
   ```

3. **Create GitHub Release:**
   ```bash
   # Using GitHub CLI
   gh release create v1.0.1 --title "v1.0.1" --notes "Release notes here"

   # Or manually at:
   # https://github.com/beshkenadze/langgraph-checkpoint-libsql/releases/new
   ```

4. **GitHub Actions will automatically:**
   - Run tests
   - Build the package
   - Publish to npm with provenance

### Manual Publish (without GitHub Actions)

```bash
# Build first
bun run build

# Login to npm (one-time)
npm login

# Publish
npm publish --access public
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

- Format code: `bun run format`
- Check formatting: `bun run format:check`
- Lint: `bun run lint`
- Fix linting issues: `bun run lint:fix`

## Testing

All tests must pass before merging:

```bash
bun run test
```

The test suite uses Vitest and runs the exact same tests as the original `@langchain/langgraph-checkpoint-sqlite` to ensure API compatibility.

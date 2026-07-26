# Contributing to Meshterm

## Setup

Requirements: Bun 1.3 or newer.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

## Structure

```text
packages/
├── server/server.ts     HTTP routing and process bootstrap
├── server/transport.ts  SQLite transport state machine
├── client/index.ts      Generic downstream client
├── mcp/index.ts         STDIO MCP adapter
└── cli/index.ts         CLI and Desktop configuration
```

## Design constraints

- Keep payloads opaque.
- Derive sender identity from the credential.
- Preserve at-least-once delivery and explicit ack-after-processing.
- Use SQLite transactions for delivery transitions.
- Never log payloads or credentials.
- Keep task, repository, approval, execution, and result semantics downstream.
- Do not add rooms, skills, TUI, terminal injection, or product telemetry back
  into the core.

Every behavior change needs a focused Bun test. Server API tests may require
permission to bind a loopback port.

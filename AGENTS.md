# Meshterm

## Product boundary

Meshterm is a generic authenticated durable transport. It owns principals,
channels, opaque messages, recipient deliveries, leases, acknowledgements,
retries/dead letters, and transport observability.

Do not add coding-task lifecycle, approvals, repository transfer, artifacts,
agent execution, or result handling. Those belong in
`persistent-coding-agent-delegation`.

Do not reintroduce rooms/conversation policy, skill transfer, task projections,
TUI, outbound product telemetry, dynamic webhooks, terminal screen scraping, or
keystroke injection into the core.

## Commands

```bash
bun run typecheck
bun test
bun run build
```

Run the server:

```bash
MESH_OPERATOR_TOKEN='<32+ random characters>' \
MESH_DATABASE='./meshterm.sqlite' \
bun run packages/server/server.ts
```

## Stack and layout

- Bun and TypeScript
- Bun native HTTP
- `bun:sqlite` with WAL and foreign keys
- Bearer credentials per principal; only digests are stored
- STDIO MCP adapter for Codex Desktop and Claude Desktop

```text
packages/
├── server/  transport store and HTTP API
├── client/  generic typed transport client
├── mcp/     pull-only STDIO MCP adapter
└── cli/     client, operator, and Desktop setup commands
```

## Invariants

- Sender identity always comes from authentication.
- A recipient can claim/ack only its own delivery.
- Claim is atomic, oldest-first, and never acknowledgement.
- Ack requires the live lease token and occurs after successful processing.
- Accepted messages and delivery state survive restart.
- Payload and attributes remain opaque and never appear in logs.
- Unacknowledged work is never deleted by count-based retention.
- Desktop integration never pushes remote content into an idle chat.

## Learning law

After every non-trivial solved problem, run the extract-approach skill and write
`.learnings/YYYY-MM-DD-<slug>.md`.

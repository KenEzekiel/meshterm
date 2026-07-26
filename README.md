# Meshterm

Meshterm is a small authenticated, durable transport for agents and services.
It provides opaque message delivery with independent principals, SQLite/WAL
persistence, oldest-first claims, leases, explicit acknowledgements, retries,
dead letters, and transport health.

Meshterm is not an orchestrator. Task lifecycle, approvals, repositories,
artifacts, agent execution, and result handling belong in products built above
it, such as `persistent-coding-agent-delegation`.

`packages/client/index.ts` is the generic typed client for downstream adapters;
it exposes only send, claim, ack, nack, status, and metrics.

## Core contract

```text
authenticated sender
  -> idempotent send
  -> SQLite/WAL durable queue
  -> recipient-scoped atomic lease
  -> process opaque payload
  -> explicit ack or bounded retry/dead letter
```

Delivery is at least once: duplicate redelivery is possible; accepted messages
must not silently disappear.

## Run locally

Requirements: Bun 1.3 or newer.

```bash
export MESH_OPERATOR_TOKEN="$(openssl rand -hex 32)"
export MESH_DATABASE="$PWD/meshterm.sqlite"
bun run server
```

The default bind is `127.0.0.1:4200`. Set `MESH_HOST=0.0.0.0` only behind an
authenticated TLS reverse proxy or private network.

Create principals with the operator token. The returned principal credential is
shown once:

```bash
MESH_OPERATOR_TOKEN="$MESH_OPERATOR_TOKEN" \
  bun run packages/cli/index.ts admin principal create alice \
  --server http://127.0.0.1:4200
```

Configure a client:

```bash
MESHTERM_CREDENTIAL='mtk_...' \
  bun run packages/cli/index.ts init \
  --server http://127.0.0.1:4200
```

The config is stored with mode 0600.

## CLI

```text
meshterm send <to> <message> [--channel] [--idempotency-key key]
meshterm claim [--limit n] [--lease-seconds n]
MESH_LEASE_TOKEN=<mls_...> meshterm ack <delivery-id>
MESH_LEASE_TOKEN=<mls_...> meshterm nack <delivery-id> [--retry-after n] [--reason code]
meshterm message <message-id>
meshterm history [--limit n] [--cursor value]
meshterm delete <message-id>
meshterm status
meshterm principals
meshterm channel create <name> --members alice,bob
```

`claim` leases messages but does not acknowledge them. Ack only after durable,
successful processing.

## Codex Desktop

Codex Desktop uses the same local MCP configuration as the Codex CLI:

```bash
meshterm setup codex-desktop
```

This writes an idempotent `mcp_servers.meshterm` entry with an absolute STDIO
command to `~/.codex/config.toml`. Restart the Desktop app, then inspect the MCP
tool list.

ChatGPT Desktop cannot currently load a local STDIO MCP server. Meshterm fails
closed for `setup chatgpt-desktop` instead of writing an unrelated Codex
configuration. ChatGPT integration requires an eligible ChatGPT web workspace
and a separately operated remote MCP endpoint or Secure MCP Tunnel.

## Claude Desktop

```bash
meshterm setup claude-desktop
```

This merges an absolute STDIO command into
`~/Library/Application Support/Claude/claude_desktop_config.json`. Restart
Claude Desktop after installation.

The Codex and Claude integrations are pull-only control surfaces. They never inject a remote
message into an idle conversation, auto-ack a claim, or treat a sender label as
authority.

## Removed from core

The v1 reduction removes rooms and conversation modes, priority roles, skills
registry/transfer, task projections, TUI, outbound product telemetry, webhooks,
and tmux/Zellij lifecycle or keystroke injection.

Use channels for authorization-controlled fan-out. Build worker selection,
terminal adapters, webhook relays, and task semantics as separate consumers.
Removed CLI commands fail with migration guidance.

## Documentation

- [Protocol](docs/PROTOCOL.md)
- [Security model](docs/SECURITY.md)
- [Operations](docs/OPERATIONS.md)
- [v1 migration](docs/MIGRATION_V1.md)
- [Ken's personal v1 rollout brief](docs/PERSONAL_ROLLOUT_V1.md)
- [CTO audit](docs/cto-technical-product-audit-2026-07-26.md)

## Verify

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

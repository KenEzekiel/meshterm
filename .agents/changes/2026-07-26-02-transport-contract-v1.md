# Transport Contract v1

## Result

The uncommitted Meshterm tree is now a reduced generic transport foundation:
per-principal credentials, SQLite WAL, idempotent opaque messages, FIFO atomic
leases, explicit ack/nack, bounded retry/dead-letter state, restart recovery,
readiness/metrics, a typed client, and pull-only Codex Desktop and Claude
Desktop MCP integration. ChatGPT Desktop local MCP is explicitly reported as
unsupported rather than being conflated with Codex.

## Product reduction

Removed from core: rooms, priority roles, skills registry/transfer, task
projections, TUI, product telemetry, webhooks, terminal lifecycle, screen
scraping, and keystroke injection.

Channels are authorization-controlled fan-out only. Task and coding semantics
remain in `persistent-coding-agent-delegation`.

## Verification

- TypeScript strict typecheck
- Bun transport, server, client, MCP, CLI, restart, poison-message, and Desktop
  integration tests
- Live two-principal claim/crash/restart/reclaim/ack test
- Live STDIO MCP send/claim roundtrip
- Bun build
- Docker Compose validation
- Non-root Docker image build and readiness smoke
- Three independent read-only final reviews with no release blockers
- Focused security review covering identity derivation, authorization, secret
  storage/logging, request/response bounds, lease scope, and destructive
  retention validation

No commit, push, PR, deployment, production mutation, or downstream delegation
code change was performed.

# Transport Contract v1 Tasks

- [x] Implement SQLite WAL schema, migrations, integrity/readiness checks.
- [x] Implement principal credentials and operator provisioning/revocation.
- [x] Implement direct/channel authorization and opaque idempotent send.
- [x] Implement atomic FIFO claim, leases, ack, nack, expiry, backoff, and DLQ.
- [x] Implement status/history, metrics, structured redacted logs, live/readiness.
- [x] Replace the server monolith and remove rooms, roles, skills, tasks,
      webhooks, telemetry, and in-memory JSON state.
- [x] Rewrite MCP as an explicit claim/ack adapter with no implicit ack or push.
- [x] Trim CLI to core transport/admin/setup commands and secure shared config.
- [x] Remove TUI and core terminal/agent lifecycle build surfaces.
- [x] Add Codex Desktop and Claude Desktop configuration packaging; fail closed
      with accurate guidance for unsupported local ChatGPT Desktop MCP.
- [x] Publish protocol, security, operations, feature-migration, and delegation
      adapter migration documentation.
- [x] Add contract, authorization, concurrency, restart, poison, MCP, and
      Desktop packaging tests.
- [x] Run a live two-principal crash-window test and downstream compatibility
      verification.
- [x] Run post-implementation review, security scan, and learnings capture.

# Transport Contract v1 Requirements

## Goal

Make Meshterm a production-ready, generic, durable transport for agent and
service messages while keeping task lifecycle, approvals, repositories,
artifacts, execution, and recovery in downstream products.

## Functional requirements

1. Every caller is authenticated as a server-managed principal with an
   independently revocable credential.
2. Sender identity is derived from the credential. A request cannot assert a
   different sender.
3. A principal can send directly to another active principal. A principal can
   publish to a channel only when its membership permits publishing, and only
   channel members receive a delivery.
4. Accepted messages are stored transactionally in SQLite using WAL before a
   success response is returned.
5. A repeated idempotency key from the same sender and identical input returns
   the original receipt. Reuse with different input is rejected.
6. Recipients claim their own deliveries oldest-first. Claiming is atomic and
   leases each delivery to one worker at a time.
7. A delivery is acknowledged only by its recipient using its active lease
   token after successful processing.
8. An unacknowledged lease becomes eligible for redelivery after expiry.
9. Rejections and expired leases apply bounded exponential backoff. A delivery
   that exhausts its maximum attempts moves to dead-letter state.
10. Operators can inspect dead letters and explicitly retry or discard them.
11. Server restart preserves queued, leased, acknowledged, and dead-letter
    state. A crash between claim and ack eventually redelivers the same
    delivery.
12. The API returns stable message and delivery IDs, authenticated sender,
    recipient, timestamps, attempt count, and lease information while treating
    payload and metadata as opaque bounded values.
13. Liveness is side-effect free. Readiness verifies the durable store and
    schema. Metrics expose queue depth, oldest age, active leases, retries, dead
    letters, and delivery latency without payloads, credentials, or secrets.
14. A compatibility note explains the old shared-secret polling API and the
    downstream delegation-adapter migration.
15. The local MCP adapter is installable in Codex Desktop and Claude Desktop.
    Poll/claim never acknowledges implicitly, and no remote message is injected
    into an idle conversation. ChatGPT Desktop setup must fail with accurate
    guidance because ChatGPT does not support local STDIO MCP; a future ChatGPT
    integration requires a remote MCP endpoint or Secure MCP Tunnel.

## Product reduction requirements

- Keep: durable send/claim/ack/nack/status/history, principals, channels,
  readiness/metrics, thin CLI, thin MCP adapter, local profiles.
- Redesign: roles as consumer-group queues; webhooks and terminal automation as
  optional external consumers; profiles through one validated secure config
  module.
- Remove from the core product: conversational rooms/modes, skills registry and
  transfer, task projections, TUI, default outbound telemetry, terminal session
  launching, screen scraping, and keystroke injection.
- Existing removed commands must fail with a clear migration message rather
  than silently doing something different.

## Safety and boundaries

- Never log payloads, bearer tokens, credential digests, or webhook secrets.
- Credential-bearing local files must be mode 0600.
- Meshterm never interprets coding-agent fields.
- No delegation worker, repository-transfer, task-state, approval, or result
  implementation is moved into this repository.
- No commit, push, deployment, production change, or external message is part
  of this goal.

## Acceptance criteria

- Automated tests prove authentication, spoof rejection, direct and channel
  authorization, FIFO order, atomic exclusive claims, ack ownership,
  idempotency, lease expiry/redelivery, bounded retry, dead-letter handling,
  restart durability, and side-effect-free readiness/metrics.
- A two-principal integration test sends, claims, closes the server/store before
  ack, reopens it, reclaims the same delivery after expiry, acknowledges it,
  and proves it cannot be claimed again.
- MCP protocol tests prove initialize/list/call, stdout purity, full structured
  claim results, explicit ack/nack, and sanitized failures.
- Desktop packaging/configuration tests prove an absolute executable path and
  secrets via environment/config rather than command arguments.
- The current delegation adapter has a documented mechanical migration to v1
  without changing its event envelope or execution semantics.

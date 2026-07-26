# Transport Contract v1 Design

## Boundary

Meshterm is an at-least-once delivery service. It owns authenticated principals,
routing, immutable messages, recipient deliveries, leasing, acknowledgements,
retry/dead-letter state, and transport observability. Payloads and attributes
are opaque.

The persistent delegation product remains the authority for tasks, sequencing,
approvals, workspaces, repositories, artifacts, execution, and results.

## API

All `/v1` routes use `Authorization: Bearer <principal credential>`.
Administrative routes additionally require the operator credential.

- `POST /v1/messages`
  - body: `{to:{kind:"principal"|"channel",name}, payload, content_type?,
    attributes?, reply_to?, max_attempts?}`
  - header: `Idempotency-Key`
  - response: immutable message receipt plus delivery IDs.
- `POST /v1/claims`
  - body: `{limit, lease_seconds}`
  - claims the authenticated principal's mailbox oldest-first.
- `POST /v1/deliveries/:id/ack`
  - body: `{lease_token}`.
- `POST /v1/deliveries/:id/nack`
  - body: `{lease_token,retry_after_seconds?,reason_code?}`.
- `GET /v1/messages/:id`
  - side-effect-free sender/recipient status.
- `GET /v1/history`
  - bounded, cursor-based authenticated history.
- `GET /v1/dead-letters`
  - operator or mailbox-owner inspection without payload by default.
- `POST /v1/dead-letters/:id/retry`
  - explicit operator retry.
- `DELETE /v1/dead-letters/:id`
  - explicit operator discard.
- `GET /livez`, `GET /readyz`, `GET /v1/metrics`.
- Operator principal/channel provisioning routes and matching CLI commands.

## Data model

SQLite is opened with `foreign_keys=ON`, `journal_mode=WAL`,
`synchronous=FULL`, and a bounded busy timeout.

- `schema_migrations`
- `principals(id,name,kind,status,created_at,updated_at)`
- `credentials(id,principal_id,secret_hash,status,created_at,revoked_at)`
- `channels(id,name,created_by,created_at)`
- `channel_members(channel_id,principal_id,can_send,created_at)`
- `messages(id,sender_id,route_kind,route_id,payload,content_type,
  attributes_json,reply_to,idempotency_key,input_hash,created_at)`
- `deliveries(id,message_id,recipient_id,state,available_at,attempt_count,
  max_attempts,lease_owner_id,lease_token_hash,leased_at,lease_expires_at,
  acknowledged_at,dead_lettered_at,last_error_code,created_at)`
- `delivery_attempts(id,delivery_id,attempt_number,principal_id,claimed_at,
  lease_expires_at,finished_at,outcome,reason_code)`

## State machine

`queued -> leased -> acknowledged`

`leased -> queued` on retryable nack or lease expiry while attempts remain.

`leased -> dead_letter` when attempts are exhausted or a non-retryable nack is
requested.

`dead_letter -> queued` only after an explicit authorized retry.

Claims execute in one immediate transaction: expire prior leases, select
eligible rows ordered by `available_at, created_at, id`, assign random lease
tokens, increment attempts, and append attempt records. Only token hashes are
stored.

## Identity

Credentials are random high-entropy bearer values. SQLite stores SHA-256
digests only and comparisons are constant-time. The authenticated principal is
the sender and the only mailbox it may claim. Direct delivery is allowed only
to active principals. Channel delivery requires `can_send` membership and fans
out to active channel members other than the sender.

The operator bootstrap token is distinct from principal credentials and exists
only in process configuration. Operator endpoints create and revoke principals
and manage channel membership. Returned raw credentials are shown once.

## Compatibility

The JSON/shared-secret API is not authoritative v1. A migration document maps:

- `POST /messages` -> `POST /v1/messages`
- `GET /messages/:agent?unread=true` -> `POST /v1/claims`
- `PATCH /messages/:id/read` -> `POST /v1/deliveries/:id/ack`

The delegation adapter adds a principal credential, idempotency key, and lease
token. It continues to validate and durably ingest its own event before ack.

Legacy rooms, roles, skills, task views, body search, TUI, webhooks, telemetry,
and terminal injection are not migrated into v1.

## Desktop integration

The MCP process is a newline-delimited JSON-RPC STDIO server whose stdout is
protocol-only and whose logs use stderr. Its core tools are:

- `mesh_send`
- `mesh_claim` (and deprecated non-acking `mesh_poll` alias)
- `mesh_ack`
- `mesh_nack`
- `mesh_message`
- `mesh_status`

Codex Desktop uses the Codex MCP configuration and an absolute command path.
Claude Desktop receives an idempotent config installer. ChatGPT Desktop cannot
load this local STDIO adapter, so its setup command fails with guidance toward
an eligible ChatGPT web workspace and a separately operated remote MCP endpoint
or Secure MCP Tunnel. Neither supported local integration emits unsolicited
message content or performs prompt injection.

## Reduction decisions

- Rooms: remove. Channel fan-out has no conversation policy.
- Roles: remove priority/capability routing. Generic consumer groups are a
  future queue type; direct principals and channels cover v1.
- Skills/tasks/TUI/telemetry: remove.
- Webhooks and terminal automation: extract from core; do not silently preserve
  unsafe push/injection behavior.
- CLI/MCP: retain and rewrite around the v1 contract.

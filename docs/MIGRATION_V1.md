# Migration to Transport Contract v1

V1 is intentionally not wire-compatible with the shared-secret polling API.
The old API was forgeable, newest-first, lossy under retention, and unable to
represent authoritative claim/ack state. Old routes now return HTTP 410 to an
authenticated v1 caller.

## API mapping

| Legacy | V1 |
|---|---|
| `x-mesh-secret` | one `Authorization: Bearer mtk_...` credential per principal |
| body `from_agent` | server-derived authenticated sender |
| `POST /messages` | `POST /v1/messages` plus `Idempotency-Key` |
| `GET /messages/:agent?unread=true` | `POST /v1/claims` |
| `PATCH /messages/:id/read` | `POST /v1/deliveries/:id/ack` with lease token |
| client retry map | durable nack/backoff/dead-letter |
| rooms | ACL-controlled channel fan-out or downstream orchestration |
| roles | downstream worker selection; a future generic consumer group if needed |
| skills/tasks/search | downstream product or artifact/index service |

The legacy JSON store is retained by the operator as an export/archive. It
cannot safely create v1 credentials or infer authoritative principals, so it is
not silently imported. Provision principals explicitly and replay only
operator-reviewed unacknowledged payloads with new idempotency keys.

## Persistent delegation adapter

Change only the transport adapter:

1. replace `secret` and `agent` with the agent's own v1 credential;
2. add the delegation event ID as `Idempotency-Key`;
3. map `body` to opaque `payload` and retain generic metadata as `attributes`;
4. replace unread polling with `POST /v1/claims`;
5. persist the returned lease token with the transport receipt;
6. validate and durably ingest the delegation event exactly as today;
7. ack the delivery with its lease token only after ingest succeeds;
8. nack malformed/retryable poison messages so they cannot starve the queue.

Do not move task states, sequences, repository packaging, approvals, execution,
artifacts, recovery, or result handling into Meshterm.

## Feature migration

- Stop any Meshterm daemon or terminal injector before upgrade.
- Replace TUI use with the core CLI or Desktop MCP tools.
- Move webhook destinations into a separately authenticated consumer/relay.
- Export any room/skill metadata needed for historical reference.
- Restart Desktop apps after running their new setup command.

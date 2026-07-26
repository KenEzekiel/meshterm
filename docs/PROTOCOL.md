# Transport Protocol v1

All `/v1` requests use `Authorization: Bearer mtk_...`.

## Send

`POST /v1/messages` with `Idempotency-Key`:

```json
{
  "to": { "kind": "principal", "name": "worker-a" },
  "payload": "opaque string",
  "content_type": "application/json",
  "attributes": { "schema": "consumer-owned" },
  "max_attempts": 5
}
```

The server derives the sender. Identical input under the same sender/key returns
the original message and delivery IDs. Different input under the same key is
HTTP 409.

Channel sends require sender membership with send access and create an
independent delivery for each other active member. Channel owners can list
their visible channels, add/update members with `can_send`, and remove members;
membership is enforced on every publish.

## Claim

`POST /v1/claims`:

```json
{ "limit": 10, "lease_seconds": 60 }
```

The server atomically leases the authenticated principal's oldest eligible
deliveries and returns a secret lease token for each. An active lease excludes
other claimers. Claim is not acknowledgement. `limit` is an upper bound; the
server may return fewer items to enforce an aggregate response-size cap.

## Ack and nack

`POST /v1/deliveries/:id/ack`:

```json
{ "lease_token": "mls_..." }
```

`POST /v1/deliveries/:id/nack`:

```json
{
  "lease_token": "mls_...",
  "retry_after_seconds": 10,
  "reason_code": "temporary_failure"
}
```

Ack is recipient- and token-scoped and idempotent with the same token. A stale
or reassigned token returns 409. Nack durably schedules retry; exhausted
deliveries enter dead-letter state.

## State

```text
queued -> leased -> acknowledged
             |
             +-> queued       retry or expired lease
             `-> dead_letter  attempts exhausted
```

Operators may retry or discard dead letters. Discard is an explicit state, not
silent deletion.

`GET /v1/history?limit=50&cursor=...` returns an authorized, side-effect-free,
bounded page. The returned opaque cursor continues from the last delivery.

The authenticated sender may `DELETE /v1/messages/:id` only after every
delivery is acknowledged or explicitly discarded. Operators can apply bounded
terminal-message retention with
`DELETE /v1/operator/retention?before=<ISO timestamp>&limit=<n>`.

## Delivery guarantees

- FIFO among eligible deliveries for one recipient.
- At-least-once delivery.
- Transactional accepted-message durability.
- Lease redelivery after worker crash.
- Payload opacity.
- No global exactly-once execution guarantee; consumers must remain
  idempotent.

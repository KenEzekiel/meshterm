# Credentialless status broker contract

Meshterm can request principal-scoped transport status through a local broker
without reading a principal credential. The protocol is host-neutral: any
runtime may implement it, and Meshterm core does not own credential custody,
local-user policy, service supervision, or container integration.

```bash
meshterm status --broker-socket /absolute/path/to/status.sock
```

`MESHTERM_BROKER_SOCKET` provides the same explicit selection for managed
installations. Broker mode never loads or falls back to a Meshterm credential
profile. Without broker selection, the existing direct credential-backed
status behavior remains unchanged.

## Protocol v1

The transport is a local Unix-domain byte stream. Each connection carries one
UTF-8 JSON request line and one JSON response line. Requests are limited to 512
bytes, responses to 8192 bytes, and the default client deadline is three
seconds.

Request:

```json
{"version":1,"request_id":"UUID","operation":"status"}
```

The only operation is the literal `status`. There are no caller-controlled
paths, methods, URLs, headers, credentials, bodies, or passthrough arguments.
Unknown fields, duplicate fields, unsupported versions, mismatched request
identifiers, extra frames, oversized data, and invalid metric values fail
closed.

A success response contains:

```json
{
  "version": 1,
  "request_id": "UUID",
  "ok": true,
  "status": {
    "ready": true,
    "schema_version": 2,
    "journal_mode": "wal",
    "queue_depth": 0,
    "active_leases": 0,
    "acknowledged": 0,
    "dead_letters": 0,
    "discarded": 0,
    "retries": 0,
    "oldest_message_age_ms": 0,
    "average_delivery_latency_ms": 0
  }
}
```

Metrics describe the mailbox of the principal authenticated by the external
broker. They are not global server metrics.

## Broker requirements

A conforming credential-bearing broker is external to Meshterm core. It must:

- authorize the local peer using kernel-provided identity, never request JSON;
- keep its fixed Meshterm origin and profile inaccessible to callers;
- permit only GET `/readyz` and authenticated GET `/v1/metrics`;
- reject invalid input before profile reads or network access;
- validate and reconstruct the response from the exact field allowlist;
- enforce request, response, connection, concurrency, rate, and time bounds;
- log only bounded audit metadata without credentials, headers, payloads,
  profile contents, lease tokens, or raw upstream bodies;
- fail closed on authentication, audit, parsing, TLS, timeout, readiness, or
  response-validation failures.

This contract is not a generic HTTP proxy and exposes no message, delivery,
principal, channel, dead-letter, or operator action.

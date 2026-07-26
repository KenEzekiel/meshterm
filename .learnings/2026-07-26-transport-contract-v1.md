---
problem: Meshterm mixed lossy shared-secret messaging with orchestration and unsafe delivery adapters
solved: 2026-07-26
domain: durable agent transport
---

## Problem

The broker trusted caller-supplied identities, persisted mutable arrays to one
JSON file, treated polling as delivery, and mixed rooms, roles, skills, tasks,
webhooks, terminal control, and TUI behavior into the transport. That could not
provide authoritative at-least-once delivery for persistent delegation.

## Key Insight

A "dumb pipe" still needs a strict state machine and identity boundary. Keep the
payload opaque, but make every delivery transition authenticated,
recipient-scoped, transactional, and restart-recoverable.

## Approach

1. Traced every server endpoint, client mutation, downstream adapter assumption,
   and feature consumer before changing code.
2. Froze a generic v1 contract: independently credentialed principals,
   idempotent send, FIFO atomic claim/lease, explicit ack/nack, bounded retries,
   dead letters, and store-aware readiness.
3. Replaced JSON/in-memory state with SQLite WAL tables for immutable messages,
   recipient deliveries, and append-only attempts.
4. Removed conversation/orchestration and unsafe push surfaces from core.
5. Rebuilt CLI and MCP around explicit pull and acknowledgement.
6. Proved the crash window by closing and reopening the same database between
   claim and ack, then reclaiming the same IDs.
7. Verified the exact STDIO process used by Codex Desktop and Claude Desktop
   against a live local server, and made ChatGPT Desktop setup fail closed
   because that app cannot load a local STDIO MCP server.

## Gotchas

- Polling must not auto-ack or even mutate status views.
- A message and its recipient delivery are separate facts; channel fan-out
  needs one delivery row per recipient.
- Persist only lease-token digests, but retain the digest after ack if repeated
  same-token ack must be idempotent.
- Resetting an attempt counter when retrying a dead letter collides with an
  immutable `(delivery, attempt_number)` audit trail; extend the retry budget
  instead.
- SQLite WAL durability is not enough unless claims and attempt creation happen
  in one immediate transaction.
- Desktop MCP setup needs an absolute executable path and protocol-only stdout;
  it should never deliver remote content unsolicited.
- Product names are protocol boundaries: a Codex config is not a ChatGPT
  integration. Unsupported host capabilities must be surfaced, not relabeled.

## Reusable Pattern

WHEN a transport feeds durable work, DO model immutable messages and
recipient-specific delivery leases separately, BECAUSE at-least-once recovery,
fan-out, poison handling, and authorization all attach to the delivery rather
than the payload.

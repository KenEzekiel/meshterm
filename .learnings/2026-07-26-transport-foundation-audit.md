---
problem: Assess whether Meshterm can safely underpin persistent coding-agent delegation
solved: 2026-07-26
domain: agent transport reliability and security
---

## Problem

Meshterm works as a lightweight trusted-agent message pipe, but the planned
delegation product needs authoritative task, approval, cancellation, and result
events to survive disconnects and failures. The audit needed to separate generic
transport responsibilities from delegation-specific orchestration while
checking the actual cross-repository contract.

## Key Insight

A transport can remain semantically "dumb" while still providing strong
principal identity, transactional persistence, idempotency, ordered claim/lease,
acknowledgement, retention, and observability. Those are transport guarantees,
not coding-task intelligence.

## Approach

1. Trace every producer, server mutation, consumer, acknowledgement, and
   persistence boundary.
2. Derive the ideal transport contract from the downstream product's explicit
   offline, audit, approval, and recovery requirements.
3. Review correctness, state integrity, security, integration, packaging, CI,
   and operations independently.
4. Reproduce high-impact state changes against an isolated server.
5. Verify downstream tests separately so environment restrictions are not
   mistaken for product failures.
6. Rank findings by user harm and dependency order, then define measurable exit
   gates.

## Gotchas

- A shared secret authenticates mesh membership, not sender identity.
- Matching an event's source field to a caller-controlled transport field does
  not prevent spoofing.
- "Fetched" is misleading if a monitoring call can set it, multiple consumers
  can fetch it, or push delivery never sets it.
- Newest-window unread polling can permanently starve an older valid event.
- Retention by array position silently discards unread work.
- A passing CI wrapper can hide a missing type checker and a nonexistent test
  suite.
- Security review must include convenience flows such as skill sharing; network
  data must never become a local path without containment and authorization.

## Reusable Pattern

WHEN one system becomes the foundation for a more reliable product, DO derive
its required contract from downstream failure and trust requirements, then
trace and test every boundary, BECAUSE happy-path feature parity does not prove
durability, attribution, or recovery.

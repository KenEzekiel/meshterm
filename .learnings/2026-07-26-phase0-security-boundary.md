---
problem: Mesh messages could trigger local skill file writes and reads while generated guidance granted spoofable sender labels authority.
solved: 2026-07-26
domain: agent messaging security
---

## Problem

The CLI interpreted ordinary message bodies as an executable skill-transfer
protocol. Any holder of the shared mesh secret could write attacker-selected
paths, request local files, or claim a human sender label; insecure default
secrets and false-green CI made those boundaries easy to miss.

## Key Insight

A shared transport credential authenticates mesh membership, not sender
identity or authority. Message content must remain inert until a separate,
explicitly approved and authenticated capability interprets it.

## Approach

1. Added failing regression tests that sent traversal and exfiltration-shaped
   messages through the real CLI polling flow.
2. Removed automatic skill protocol interpretation and disabled the explicit
   file-transfer commands while preserving metadata discovery.
3. Replaced unconditional trust text in generated and packaged guidance.
4. Added a safe upgrade path for persistent Kiro/Claude guidance and prevented
   automatic terminal delivery where provider-specific guidance cannot be
   installed.
5. Required an explicit non-default server secret in source, Compose, and the
   OpenClaw setup path.
6. Replaced masked CI checks with pinned dependencies, strict typecheck, tests,
   build, and readiness smoke checks.
7. Verified the boundaries with runtime tests, startup failures, Compose
   validation, and independent reviews.

## Gotchas

- Removing the live handler is incomplete if explicit CLI commands and
  architecture diagrams still advertise the unsafe protocol.
- Package upgrades do not rewrite steering files stored in user directories;
  security guidance needs an explicit, tested migration path.
- Auto-delivery must stay off for integrations where Meshterm cannot install a
  matching trust boundary.
- `Response.json()` is `unknown` under current TypeScript/Bun types, so a real
  fail-closed typecheck exposes API-boundary debt previously hidden by CI.
- Validate trimmed secret content, but preserve the original opaque value so
  client and server credentials do not diverge.

## Reusable Pattern

WHEN a network message can cause code or file behavior, DO keep transport
payloads inert and require a separate authenticated, scoped, user-approved
operation, BECAUSE transport access alone cannot establish actor authority.

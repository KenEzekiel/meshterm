---
problem: Deploy an incompatible transport rewrite without breaking active legacy agents
solved: 2026-07-26
domain: staged agent transport rollout
---

## Problem

The VPS had a dirty legacy checkout, a manual broker owning port 4200, a
duplicate systemd service in a restart loop, and active clients that depended on
removed v0 APIs. A direct replacement would have broken Kiro, OpenClaw, Mac
agents, and the delegation adapter at once.

## Key Insight

Deploy the new contract beside the old broker and migrate identity plus client
behavior independently. A loopback-only v1 server with a private SSH tunnel
allows real Desktop verification without exposing the new API or forcing a
premature public cutover.

## Approach

1. Inventory active principals, processes, service ownership, dirty source, and
   downstream adapter compatibility.
2. Back up the dirty diff, JSON state, service unit, client config, and steering
   before stashing and fast-forwarding the checkout.
3. Run the full suite on the exact VPS revision.
4. Install a separate hardened systemd service and fresh SQLite database on a
   new loopback port.
5. Prove the production crash window before provisioning permanent consumers.
6. Give Codex, Claude, and Kiro separate credentials and mode-0600 profiles.
7. Use a persistent SSH tunnel for local Desktop consumers, then verify the
   actual Claude MCP status and Codex registry.
8. Revoke temporary principals and delete one-time credential and lease files.

## Gotchas

- A service can appear broken while an unmanaged duplicate process is actually
  serving production; trace the listening PID before stopping anything.
- A green shell command can hide an earlier failed check when later commands
  succeed. Keep deployment gates fail-fast.
- A sandboxed local curl can report connection refused even when launchd and
  `lsof` prove the tunnel is listening. Re-run the same probe with permitted
  loopback access before changing configuration.
- Do not reuse a secret extracted from another process to notify legacy agents.
  Deliver briefs through reviewed files and newly provisioned identities.
- Do not restart the app hosting the active deployment task; verify its registry
  and defer its application restart explicitly.

## Reusable Pattern

WHEN a new protocol is intentionally incompatible with active consumers, DO
run old and new services in parallel and migrate one credentialed consumer at a
time, BECAUSE rollback remains local and contract failures do not become a
fleet-wide outage.

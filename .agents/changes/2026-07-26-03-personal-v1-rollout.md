# Personal Transport v1 rollout

## Result

Meshterm v1 is running in parallel on Ken's VPS as
`meshterm-v1.service` at `127.0.0.1:4210`. The public legacy broker remains
available on port 4200 while consumers migrate.

## Deployed revision

- Core v1: `0a765d8`
- Tunnel and rollout documentation: `cde9a17`
- Both GitHub Actions runs passed.

## Consumers

- `kiro-vps`: principal and mode-0600 profile installed; reviewed brief copied
  into Kiro steering; active legacy session not restarted.
- `mac-codex`: principal, mode-0600 profile, Codex MCP entry, and successful
  live transport/MCP verification.
- `mac-claude`: principal, mode-0600 profile, Claude MCP entry, live transport
  verification, and Desktop UI status `running`.

The Mac uses a persistent launchd SSH tunnel to reach the loopback-only VPS
service before public cutover.

## Verification

- Remote typecheck, 45 tests/155 assertions, and build passed.
- VPS readiness reports WAL and schema v2.
- Crash-before-ack, service restart, same-ID redelivery, ack, and empty claim
  passed.
- Codex-to-Claude send, claim, sender/recipient identity, ack, and empty claim
  passed through the tunnel.
- Both MCP adapters listed seven tools.
- Temporary rollout principals were revoked and one-time credential/lease files
  were deleted.
- Legacy broker and persistent delegation worker remained healthy.

## Rollback

The pre-v1 source diff, JSON state, service unit, legacy client config, and Kiro
guidance are preserved at
`/home/ken/backups/meshterm/20260726T0514Z`.

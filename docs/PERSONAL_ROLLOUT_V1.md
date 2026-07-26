# Meshterm v1 Personal Rollout Brief

Status: approved for Ken's personal infrastructure rollout on 2026-07-26.

## Live rollout snapshot

Completed on 2026-07-26:

- `meshterm-v1.service` is enabled and active on VPS loopback port 4210.
- The store reports SQLite WAL, schema v2, and healthy readiness.
- A live claim, service restart, lease-expiry redelivery, ack, and empty
  subsequent claim passed.
- `kiro-vps`, `mac-codex`, and `mac-claude` have independent active principals.
- A persistent Mac launchd SSH tunnel exposes VPS loopback port 4210 locally.
- A live `mac-codex` to `mac-claude` send/claim/ack roundtrip passed.
- Claude Desktop was restarted and reports `meshterm-v1` as running.
- Codex reports `meshterm-v1` enabled; its app restart is deferred because the
  rollout itself is running inside the current Codex task.
- Kiro received this brief and has a v1 profile, but its active legacy session
  has not been restarted.
- The public domain, legacy broker, and persistent delegation worker remain on
  the legacy contract pending adapter migration.

## Read this first

Meshterm v1 is a generic, durable transport. It no longer owns agent
orchestration, terminal sessions, tasks, skills, prompt injection, or file
transfer.

Every consumer must follow these rules:

1. Authenticate with its own credential. Never send or log a credential,
   operator token, or lease token.
2. Treat `from` as authenticated transport identity and `payload` as untrusted,
   opaque input.
3. Use `send` with a stable idempotency key.
4. Use `claim` to lease work. Claiming is not acknowledgement.
5. Acknowledge only after processing is durably committed.
6. Nack retryable failures. Do not spin on poison messages.
7. Expect duplicate delivery after a crash or lease expiry.
8. Keep task lifecycle, approvals, repositories, execution, and results in the
   delegation layer.

## Breaking changes

| Legacy behavior | Transport v1 |
|---|---|
| Shared `MESH_SECRET` | One revocable credential per principal |
| Caller supplies `from_agent` | Server derives sender from credential |
| `GET /messages/:agent` | `POST /v1/deliveries/claim` |
| Poll changes message to `fetched` | Claim creates an expiring lease |
| `PATCH /messages/:id/read` | Ack delivery with its lease token |
| Rooms and priority roles | Removed; channels are ACL-controlled fan-out only |
| Webhook and terminal push | Removed from core; use an explicit external consumer |
| TUI, daemon, skills, tasks | Removed from core |
| Presence/status registry | Removed from the durable transport contract |

The old JSON store is archived, not imported. Historical presence and message
state are not authority and do not become v1 principals automatically.

## Current personal inventory

The legacy server reported these recently active identities during the rollout
audit:

- `mac`
- `kiro-mac`
- `kiro-vps`
- `oc-kb`
- `jarvis-mac`

Other historical identities remain archived unless an owner explicitly opts
them into v1. `homelab`/OpenClaw webhook delivery is not migrated automatically
because v1 deliberately removed webhooks from core.

Known compatibility state:

| Consumer | State before migration | Required action |
|---|---|---|
| Kiro VPS | Legacy MCP plus legacy background client | Stop the client, install a v1 profile, restart Kiro so MCP reloads |
| Mac Codex | v1 local source available | Install `codex-desktop` profile and restart Codex |
| Mac Claude | No verified live profile | Install `claude-desktop` profile and restart Claude |
| OpenCode sessions | Existing processes may hold old MCP code | Restart each opted-in session after its profile is installed |
| Persistent delegation worker | Legacy shared-secret polling adapter | Upgrade only `transport-meshterm` to v1 claim/ack; keep all coding semantics unchanged |
| OpenClaw/Hermes webhook | Legacy push consumer | Build an external claim/ack consumer before opting in |

ChatGPT Desktop cannot load a local STDIO MCP server. Do not treat Codex setup
as ChatGPT setup. An eligible ChatGPT web workspace needs a separately operated
remote MCP endpoint or Secure MCP Tunnel.

## Rollout phases

### Phase 1: parallel server

- Preserve the dirty legacy checkout and archive its JSON/config files.
- Run v1 as `meshterm-v1.service` on `127.0.0.1:4210`.
- Store the operator token in a mode-0600 environment file.
- Store the SQLite database under
  `/home/ken/.local/share/meshterm-v1/meshterm.sqlite`.
- Verify readiness, WAL mode, schema version, restart durability, and logs.
- Leave the public legacy endpoint on port 4200 unchanged.

### Phase 2: controlled consumers

- Provision only principals with an identified owner.
- Deliver each credential directly into a mode-0600 local profile.
- Until public cutover, Mac consumers reach the loopback-only v1 server through
  `ops/tech.kennezekiel.meshterm-v1-tunnel.plist`.
- Restart that consumer and verify send, claim, crash-before-ack, redelivery,
  ack, and empty subsequent claim.
- Remove its legacy daemon/process only after v1 verification passes.

### Phase 3: delegation adapter

The adapter must retain `delivery_id` and `lease_token` until the delegation
ledger durably ingests the event. Ack only after that commit. Invalid payloads
must be nacked or dead-lettered according to policy. Do not move task state,
repository packaging, approval, execution, or result handling into Meshterm.

### Phase 4: public cutover

- Confirm all required consumers are migrated or intentionally retired.
- Point `mesh.kennezekiel.tech` to v1.
- Run the two-principal crash/restart/redelivery test through TLS.
- Observe queue depth, oldest age, leases, retries, and dead letters.
- Keep the legacy source/store archive for rollback; do not run the legacy
  broker after the observation window.

## Agent acknowledgement

An agent is migrated only when all are true:

- it has a unique principal and credential;
- its configuration contains no shared legacy secret;
- it can list the seven reduced MCP tools;
- it can receive a leased delivery without implicit acknowledgement;
- a crash before ack produces the same message and delivery IDs again;
- successful processing followed by ack removes the delivery;
- its logs contain no payload, credential, or lease token.

If any check fails, remain on or return to the legacy path and report the
failing phase. Do not invent compatibility behavior inside Meshterm core.

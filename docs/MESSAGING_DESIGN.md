# meshterm — Messaging & Agent Identity Design Doc (v2)

## Design Principle

**The pipe stays dumb.** meshterm is a message broker, not an orchestrator. Intelligence belongs in the agents, not the server. Every feature must pass this test: "Does this make the server smarter, or does it give agents better information to make their own decisions?"

---

## Problem Statement

5 fundamental gaps, ordered by impact:

1. **No delivery feedback** — sender gets `{ok: true}` but never knows if the message was received, read, or lost
2. **No agent presence** — server can't distinguish alive/dead/idle agents
3. **Identity collision** — multiple instances register as the same name, compete for messages
4. **Room model is half-baked** — rooms duplicate messages as direct messages, no clear use case distinction from direct messaging
5. **No cleanup** — stale agents, orphaned processes, dead messages accumulate forever

---

## Current Architecture (for reference)

```
SEND paths (all work):
  MCP tool (mesh_send)  → POST /messages → server stores
  CLI (meshterm send)   → POST /messages → server stores
  HTTP (curl)           → POST /messages → server stores

RECEIVE paths (heterogeneous):
  Daemon (mesh-client)  → GET /messages/:agent (5s poll) → tmux send-keys    [PUSH, reliable]
  Webhook               → server POST to URL on new message                   [PUSH, reliable]
  MCP (mesh_poll)       → agent calls tool when it wants                      [PULL, unreliable]
  CLI (meshterm poll)   → human runs command                                  [PULL, manual]
```

Key insight: **sending is uniform, receiving is fragmented.** The problems are all on the receive side.

---

## Phase 1: Message States + Heartbeat

### What we add

**Message states** (server tracks automatically):
```
queued   → stored, nobody fetched it yet
fetched  → a client retrieved it (daemon poll, MCP poll, CLI poll)
read     → agent explicitly acknowledged (new: mesh_ack)
```

No "delivered" state — "fetched" is honest. Fetched by daemon ≠ processed by agent.
No auto-expiry — messages don't disappear. If you want expiry, that's a future opt-in feature.

**Agent heartbeat:**
```
POST /agents/heartbeat {name}  → updates last_seen, lightweight
```

MCP server sends heartbeat every 30s in background thread. Daemon already updates last_seen on every poll. Webhook agents update on every webhook response.

**Sender feedback** (informational only, server doesn't act on it):
```
POST /messages response:
{
  ok: true,
  message: {...},
  recipient_last_seen: "2026-04-23T10:00:00Z",  // or null if never registered
  recipient_exists: true
}
```

**Message status check:**
```
GET /messages/:id/status → { state: "queued"|"fetched"|"read", created_at, fetched_at, read_at }
```

**New MCP tool: `mesh_ack`**
```
mesh_ack(message_id) → marks message as read, confirms to sender
```

### Tradeoffs

| Decision | Alternative | Why this way |
|----------|-------------|-------------|
| No auto-expiry | TTL with bounce-back | Auto-expiry silently loses messages. Worse than no expiry. If we add it later, make it opt-in per message with explicit bounce notification. |
| `fetched` not `delivered` | Call it "delivered" | "Delivered" implies the agent got it. Daemon fetching ≠ agent processing. Honest naming prevents false confidence. |
| Heartbeat from MCP server | Rely on last_seen from polls | MCP agents rarely poll. Without heartbeat, they always look offline. 30s heartbeat is cheap (1 tiny POST). |
| `recipient_last_seen` is informational | Use it for routing decisions | Point-in-time snapshot. Agent could die 1s later. Useful for humans ("is this agent alive?"), dangerous for routing logic. |
| `mesh_ack` is explicit | Auto-ack on fetch | Auto-ack means "daemon fetched it" = "agent read it", which is false. Explicit ack means the agent actually processed the message. |

### Steering/setup changes needed

- MCP server: add background heartbeat (30s interval)
- `mesh_ack` tool added to MCP tool list
- Agent steering files (kiro, claude, openclaw): add instruction to call `mesh_ack` after processing a mesh message
- `meshterm setup` command: update generated steering to include ack pattern

---

## Phase 2: Multi-Instance Handling

### The real problem

Multiple Kiro sessions register as `kiro-mac`. When kaze sends to `kiro-mac`:
- Daemon fetches it first (5s poll) → injects into tmux CLI session
- MCP sessions never see it (daemon already marked it fetched)
- Or: no daemon running → whichever MCP session polls first gets it, others don't

### Design constraint: keep the pipe dumb

Session targeting (send to `kiro-mac/session-123`) makes the server smart. The server would need to understand sessions, route between them, track which is "best." That's orchestrator logic.

**Instead: the server stays flat, the client handles multiplexing.**

### Option A: Daemon as the single receiver, fan-out locally

```
All messages for kiro-mac → daemon fetches → daemon decides where to inject

Daemon knows about local sessions:
  - tmux session "kiro" → inject via send-keys
  - tmux session "kiro-fdb" → inject via send-keys
  - IDE sessions → can't inject (no mechanism)
```

**Tradeoff:** Simple server, but IDE sessions are second-class citizens. Daemon becomes a local router, which is complexity in the client instead of the server. IDE agents must poll to receive.

### Option B: Multiple agent names, role for grouping

```
Register as separate agents:
  kiro-mac-cli    (daemon receives)
  kiro-mac-ide-1  (MCP poll receives)
  kiro-mac-ide-2  (MCP poll receives)

Create a role:
  meshterm role create kiro-mac --agents kiro-mac-cli,kiro-mac-ide-1,kiro-mac-ide-2

Kaze sends to:
  role:kiro-mac → routes to highest-priority online agent (kiro-mac-cli preferred)
  kiro-mac-cli  → specific agent
  role:kiro-mac --broadcast → all of them
```

**Tradeoff:** Uses existing features (roles). No server changes. But requires manual role management — every time a new session starts, it needs to register and join the role. Stale sessions accumulate in the role.

### Option C: Server-side session groups (new concept)

```
POST /agents/register { name: "kiro-mac", group: "kiro-mac" }

Server auto-groups agents with same group name.
Messages to "kiro-mac" → delivered to ALL agents in the group (broadcast by default)
  OR → delivered to the one with latest heartbeat (latest-wins)
```

**Tradeoff:** Server gets slightly smarter (group concept), but it's a thin layer — just "same name = same group." The routing decision (broadcast vs latest-wins) is still configured by the client at registration time.

### Recommendation: Option B (roles) for now, Option C later

Option B works today with zero server changes. The `meshterm setup` command can auto-create the role and register with a unique name. When we have enough usage data to know the right default behavior (broadcast vs latest-wins), implement Option C.

**Concrete steps for Option B:**
1. `meshterm setup kiro --session kiro` generates a unique agent name: `kiro-mac-<session-name>`
2. Auto-creates role `kiro-mac` if it doesn't exist
3. Adds the new agent to the role
4. On `meshterm agent stop`, removes from role

### What about session targeting to non-receiver agents?

This is why we DON'T do session targeting. If kaze sends to `kiro-mac-ide-2` and that IDE session never polls, the message is lost. With roles, kaze sends to `role:kiro-mac` and the server routes to the highest-priority online agent — which should be the daemon-connected CLI (most reliable receiver).

---

## Rooms: Scrutiny & Refined Use Cases

### Current implementation problems

1. **Room messages create duplicate direct messages** — every room message generates N-1 direct messages (one per member). This means:
   - Messages appear twice for daemon agents (room history + direct inbox)
   - Unread count is inflated
   - `mesh_poll` returns room messages mixed with direct messages
   - No way to distinguish "this is a room message" from "this is a direct task"

2. **Room membership is by agent name** — with identity collision, `kiro-mac` is a member but which instance? The room bug we hit earlier (can't send, already a member) is likely caused by this.

3. **Room modes (round-robin, reactive, moderated) are implemented but untested** — no evidence anyone has used anything other than free-form.

4. **No clear use case distinction from direct messaging** — when should kaze use a room vs direct messages?

### Refined use cases

| Use case | Direct message | Room |
|----------|---------------|------|
| Delegate a task to one agent | ✅ `meshterm send kiro-vps "deploy canopy"` | ❌ Overkill |
| Broadcast to all agents | ✅ `role:kiro-mac --broadcast` | ❌ Rooms are for conversation, not broadcast |
| Multi-agent discussion (design review, planning) | ❌ No shared context | ✅ All agents see the full thread |
| Audit trail of a collaborative task | ❌ Messages scattered across agents | ✅ Room history is the single source of truth |
| Standup / status check | ❌ Would need to poll each agent | ✅ Room where each agent posts status |

**Rooms are for conversations. Direct messages are for tasks.** This distinction should be documented.

### Room fixes needed

1. **Stop duplicating room messages as direct messages.** Instead:
   - Daemon should poll room messages separately: `GET /rooms/:name/messages?since=<timestamp>`
   - MCP should have `mesh_room_poll` tool (or `mesh_poll` returns both direct + room messages with a `source` field)
   - Webhook should fire for room messages too (with `source: "room:name"`)

2. **Room membership should work with roles.** If `kiro-mac` is a role with 3 sessions, the role is the room member, not individual sessions. Any session in the role can send to the room.

3. **Remove unused room modes** (round-robin, reactive, moderated) until there's a real use case. Keep free-form only. Less code, less bugs.

### Tradeoffs

| Decision | Alternative | Why |
|----------|-------------|-----|
| Stop room→direct duplication | Keep duplication with `source` field | Duplication is a hack. It inflates message counts, confuses agents, and creates ordering issues. Clean separation is worth the daemon change. |
| Rooms use roles for membership | Keep per-agent membership | Per-agent membership breaks with multi-instance. Role-based membership is future-proof. But it adds a dependency on roles being set up correctly. |
| Remove unused room modes | Keep them | Dead code is a liability. No one has tested round-robin/reactive/moderated. Remove and re-add when there's a real use case. |

---

## Phase 3: Bounce-Back for Stale Messages

If a message is `queued` (not fetched) for a configurable duration and the recipient has no recent heartbeat:
- Server creates a bounce message to the sender: `[meshterm] Message to <agent> not fetched after <duration>. Recipient last seen <timestamp>.`
- Original message stays queued (not deleted) — recipient can still fetch it later
- Bounce is informational, not an error

**Default: no bounce.** Opt-in per message: `{ttl_warn: "1h"}` means bounce after 1 hour.

### Tradeoff

| Decision | Alternative | Why |
|----------|-------------|-----|
| Bounce is informational, message stays | Delete message on bounce | Deleting loses the message. The recipient might come back. Bounce just tells the sender "heads up, this hasn't been picked up." |
| Opt-in, not default | Default bounce after 1h | Most messages are fire-and-forget. Default bounce would spam senders with notifications for every message to an offline agent. |

---

## Phase 4: Cleanup

**Server-side (automatic):**
- Agents with no heartbeat for 24h: mark as `expired` in agent list (still visible, excluded from role routing)
- Messages older than 7 days and in `read` state: delete
- Messages older than 30 days regardless of state: delete
- Never auto-delete agents — only mark expired. Agent re-activates on next heartbeat.

**Client-side (manual):**
- `meshterm agent cleanup` — find and kill orphaned MCP/daemon processes on local machine
- `meshterm agent deregister <name>` — remove agent from server
- `meshterm messages cleanup` — purge read messages older than N days

### Tradeoff

| Decision | Alternative | Why |
|----------|-------------|-----|
| Never auto-delete agents | Auto-delete after 7d | Agent might be offline for a week (vacation, VPS reboot). Deleting loses room memberships, role assignments. Marking expired is reversible. |
| Delete read messages after 7d | Keep forever | Storage grows unbounded. Read messages have no value after a week. 7d gives enough time for debugging. |
| Client-side process cleanup | Server-side | Server can't kill local processes. This is fundamentally a local concern. |

---

## Implementation Order

| Phase | Server changes | Client changes | Effort |
|-------|---------------|----------------|--------|
| **1: Message states + heartbeat** | Add `state` field, heartbeat endpoint, message status endpoint | MCP: add heartbeat thread + `mesh_ack` tool. Steering: update ack instructions. | Medium |
| **2: Multi-instance (roles)** | None | `meshterm setup` generates unique name + auto-creates role. `meshterm agent stop` removes from role. | Small |
| **Room fixes** | Remove room→direct duplication. Add room webhook. | Daemon: poll rooms separately. MCP: add room source to poll. Remove unused room modes. | Medium |
| **3: Bounce-back** | Check queued messages on interval, create bounce messages | None | Small |
| **4: Cleanup** | Mark expired agents, delete old messages on interval | `meshterm agent cleanup`, `meshterm agent deregister` | Small |

---

## Open Questions

1. **Should `mesh_poll` return room messages too?** Currently rooms are separate. Merging them simplifies the agent experience but mixes task messages with conversation messages.

2. **Role auto-management:** If `meshterm setup` auto-creates roles, who cleans up stale role members? The role could accumulate dead agents. Need a `meshterm role cleanup` or auto-prune on heartbeat check.

3. **Webhook for rooms:** Should the server fire webhooks for room messages? Currently only direct messages trigger webhooks. If kaze is in a room, it won't get webhook-pushed for room messages.

4. **Per-agent API keys:** Currently one shared secret. With multi-instance, any agent can impersonate another. Per-agent keys would prevent this but add key management complexity. Defer until there's a real security need (multi-user, not just multi-agent).

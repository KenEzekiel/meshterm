# meshterm — Messaging & Agent Identity Design Doc (v3 — Final)

## Design Principle

**The pipe stays dumb.** meshterm is a message broker, not an orchestrator. Intelligence belongs in the agents and clients, not the server. Every feature must pass: "Does this make the server smarter, or does it give clients better information?"

---

## Problem Statement

1. **No delivery feedback** — sender gets `{ok: true}` but never knows if the message was received
2. **No agent presence** — server can't distinguish alive/dead/idle agents
3. **Identity collision** — multiple instances register as the same name, compete for messages
4. **Room model needs refinement** — room messages duplicate as direct messages with no way to distinguish them
5. **No cleanup** — stale agents, orphaned processes, dead messages accumulate

---

## Decisions Made

| Topic | Decision | Rationale |
|-------|----------|-----------|
| `mesh_ack` | **Dropped.** `fetched` is the terminal server-side state. | Ack requires every agent to comply via steering. If they don't, data is misleading. "Fetched" is honest — the gap between fetched and processed is an agent behavior problem, not a messaging problem. Revisit if a concrete scenario demands it. |
| Room modes | **Keep all 4** (free-form, round-robin, reactive, moderated). | Use case: simulated company board (CEO/CSO/CPO gstack agents). Modes are the product differentiator for multi-agent collaboration. Need testing, not removal. |
| Multi-instance | **Option B: roles.** No server changes. | `meshterm setup` auto-creates a role for the base agent name and registers with a unique name. Keeps the pipe dumb. Server doesn't need to understand sessions. |
| Room duplication | **Keep duplication, add `source` field.** | Stopping duplication breaks daemon receive for rooms. Adding `source: "room:name"` lets agents deduplicate programmatically. No breaking change. |
| Bounce-back | **Client-side timeout**, not server-side. | `mesh_send --timeout 5m` polls message status and warns if not fetched. Server stays dumb — just stores messages and tracks state. |

---

## Phase 1: Message States + Heartbeat

### Server changes

**Message state tracking:**
```
queued   → stored, nobody fetched it yet
fetched  → a client retrieved it (daemon poll, MCP poll, CLI poll)
```

- Add `state` field to Message: default `"queued"`, set to `"fetched"` when returned by `GET /messages/:agent`
- Add `fetched_at` timestamp
- Existing `read` field (from `PATCH /messages/:id/read`) stays — it's the agent's explicit mark

**New endpoints:**
```
POST /agents/heartbeat {name}           → updates last_seen (lightweight, no body needed)
GET  /messages/:id/status               → {state, created_at, fetched_at, read_at}
```

**Enhanced send response:**
```
POST /messages response:
{
  ok: true,
  message: {...},
  recipient_last_seen: "2026-04-23T10:00:00Z",  // null if never registered
  recipient_exists: true
}
```

`recipient_last_seen` is informational only. The server does NOT use it for routing.

### Client changes

**MCP server:** Add background heartbeat — `POST /agents/heartbeat` every 30s. Cheap, keeps presence accurate for MCP agents that rarely poll.

**No steering changes needed** — no `mesh_ack`, no new agent behavior required.

### Tradeoffs

| Decision | Alternative | Why this way |
|----------|-------------|-------------|
| No auto-expiry on messages | TTL with auto-delete | Auto-expiry silently loses messages. Worse than no expiry. Add opt-in TTL later if needed. |
| `fetched` not `delivered` | Call it "delivered" | Daemon fetching ≠ agent processing. Honest naming prevents false confidence. |
| Heartbeat from MCP server | Rely on last_seen from polls | MCP agents rarely poll. Without heartbeat, they always look offline. 30s heartbeat is one tiny POST. |
| `recipient_last_seen` is informational | Use for routing | Point-in-time snapshot. Agent could die 1s later. Useful for display, dangerous for logic. |

---

## Phase 2: Multi-Instance via Roles

### How it works

No server changes. Uses existing role system.

**`meshterm setup kiro --session kiro` now does:**
1. Generates unique agent name: `kiro-mac-<session-name>` (e.g., `kiro-mac-cli`, `kiro-mac-ide-fdb`)
2. Registers with the mesh server under that name
3. Creates role `kiro-mac` if it doesn't exist (with `fallback: queue`)
4. Adds the new agent to the role
5. On `meshterm agent stop`, removes agent from role

**Addressing:**
```
meshterm send kiro-mac "task"              → role routing: picks highest-priority online agent
meshterm send kiro-mac-cli "task"          → direct: specific agent
meshterm send role:kiro-mac --broadcast    → all agents in role
```

Kaze sends to `kiro-mac` (the role) by default. Server routes to the best available agent — which should be the daemon-connected CLI (most reliable receiver, highest priority in the role).

### Why not session targeting?

Session targeting (`kiro-mac/session-123`) makes the server smart and can target non-receiver agents. If kaze sends to an MCP-only IDE session that never polls, the message is lost. With roles, the server routes to the agent with the best receive mechanism (daemon > webhook > MCP poll).

### Tradeoffs

| Decision | Alternative | Why this way |
|----------|-------------|-------------|
| Roles (existing feature) | Server-side session groups | Zero server changes. Roles already handle priority + fallback. |
| Auto-create role on setup | Manual role management | Nobody will manually create roles. Auto-create removes friction. |
| Daemon agent = highest priority | Equal priority | Daemon has reliable push receive. MCP agents are best-effort poll. Route to the reliable one. |

---

## Phase 3: Room Refinement

### Room message `source` field

When a room message creates direct message copies, add a `source` field:

```json
{
  "id": "msg-123",
  "from_agent": "ceo-agent",
  "to_agent": "cso-agent",
  "body": "[room:board-meeting] Let's discuss the security audit",
  "source": "room:board-meeting",
  "created_at": "..."
}
```

Agents can filter: `source` present = room message, `source` absent = direct task.

### Room modes — use cases

| Mode | Behavior | Use case |
|------|----------|----------|
| **free-form** | Anyone speaks anytime | Brainstorming, casual discussion |
| **round-robin** | Agents take turns in order | Structured board meeting, each agent gives input |
| **moderated** | Moderator agent controls who speaks | CEO runs the meeting, calls on agents |
| **reactive** | Agents speak only when they have relevant input | Async review, agents chime in when their domain is relevant |

These modes need testing. The server enforces them (rejects out-of-turn messages in round-robin, only moderator can "call on" agents in moderated). The agents need steering to understand the mode they're in.

### Room membership with roles

When a role is a room member, any agent in the role can send to the room. The room stores the role name as the member, not individual agents. This solves the multi-instance room membership problem.

```
Room "board-meeting" members: ["ceo", "cso", "cpo", "kiro-mac"]
                                                      ↑ this is a role
Any kiro-mac-cli or kiro-mac-ide can send to the room via the role.
```

### Webhook for room messages

Add room message webhook support. When a room message is posted, fire webhooks for members that have webhooks configured. Currently only direct messages trigger webhooks — room messages should too.

### Tradeoffs

| Decision | Alternative | Why this way |
|----------|-------------|-------------|
| Keep duplication + `source` field | Stop duplication, add room polling to daemon | No breaking change. Daemon still receives room messages. Agents can deduplicate via `source`. |
| Keep all 4 room modes | Remove unused modes | CEO/CSO/CPO board use case needs round-robin and moderated. Test them, don't remove them. |
| Role-based room membership | Per-agent membership | Per-agent breaks with multi-instance. Role-based is future-proof. |
| Room webhooks | No room webhooks | Kaze (OpenClaw) needs to receive room messages. Without webhooks, kaze misses room conversations. |

---

## Phase 4: Client-Side Timeout + Cleanup

### Send with timeout (client-side)

```bash
meshterm send kiro-mac "deploy canopy" --timeout 5m
```

The CLI sends the message, then polls `GET /messages/:id/status` periodically. If not fetched within timeout:
```
⚠️ Message to kiro-mac not fetched after 5m. Recipient last seen 2h ago.
```

For MCP, `mesh_send` gets an optional `timeout` parameter:
```
mesh_send(to: "kiro-mac", message: "deploy", timeout: "5m")
→ returns: {sent: true, fetched: false, warning: "not fetched after 5m"}
```

Default: no timeout (fire-and-forget, current behavior).

### Cleanup

**Server-side (automatic, periodic):**
- Agents with no heartbeat for 24h: mark as `expired` (visible but excluded from role routing)
- Messages in `read` state older than 7d: delete
- Messages in any state older than 30d: delete
- Never auto-delete agents — only mark expired. Re-activates on next heartbeat.

**Client-side (manual):**
```
meshterm agent cleanup                  # kill orphaned local MCP/daemon processes
meshterm agent deregister <name>        # remove agent from server
meshterm messages cleanup [--older 7d]  # purge old read messages
meshterm role cleanup <role>            # remove expired agents from role
```

### Tradeoffs

| Decision | Alternative | Why this way |
|----------|-------------|-------------|
| Client-side timeout | Server-side bounce | Server stays dumb. Client decides if it cares about delivery confirmation. |
| Fire-and-forget default | Always wait for delivery | Most messages are tasks — sender moves on. Timeout is opt-in for critical messages. |
| Never auto-delete agents | Auto-delete after 7d | Agent might be offline for a week. Deleting loses room memberships, role assignments. Marking expired is reversible. |
| 30d hard delete on messages | Keep forever | Storage grows unbounded. 30d is generous. Read messages have no value after that. |

---

## Implementation Order

| Phase | Server changes | Client changes | Effort | Depends on |
|-------|---------------|----------------|--------|------------|
| **1** | `state` + `fetched_at` on messages, heartbeat endpoint, message status endpoint, enhanced send response | MCP heartbeat thread (30s) | Medium | Nothing |
| **2** | None | `meshterm setup` generates unique name + auto-creates role. `meshterm agent stop` removes from role. | Small | Phase 1 (heartbeat for presence) |
| **3** | `source` field on room→direct copies, room webhooks, role-based room membership | Daemon/MCP: filter by `source`. Test room modes. | Medium | Phase 2 (roles for room membership) |
| **4** | Periodic cleanup (expired agents, old messages) | `meshterm agent cleanup`, `meshterm role cleanup`, `mesh_send --timeout` | Small | Phase 1 (message states) |

---

## Open Questions

1. **`mesh_poll` and room messages:** Should `mesh_poll` return room messages (with `source` field) or should rooms be polled separately via `mesh_room_history`? Merging simplifies agent experience but mixes tasks with conversations.

2. **Role auto-cleanup:** If `meshterm setup` auto-creates roles, stale agents accumulate. `meshterm role cleanup` prunes expired agents, but who runs it? Should the server auto-prune on heartbeat check?

3. **Room mode enforcement:** How strict? If an agent sends out-of-turn in round-robin, reject the message or queue it? Rejecting is simpler but the agent might not understand why its message failed.

4. **Per-agent API keys:** Deferred. Current shared secret is fine for single-user multi-agent. Revisit when multi-user is a real scenario.

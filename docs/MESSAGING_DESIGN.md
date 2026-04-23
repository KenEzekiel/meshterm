# meshterm — Messaging & Agent Identity Design Doc

## Problem Statement

meshterm has fundamental messaging gaps that become critical as the number of agents grows:

1. **No delivery guarantees** — messages to offline agents sit forever, sender never knows
2. **No agent lifecycle awareness** — server can't distinguish online/offline/dead agents
3. **Identity collision** — multiple instances register as the same agent name
4. **No cleanup** — stale agents, orphaned processes, dead registrations persist
5. **Heterogeneous receive mechanisms** — some agents poll, some get pushed, some get webhooks, and the sender has no visibility into this

## Current State

### Agent Registration
- Agents register via `POST /agents/register {name, type, host}`
- `last_seen` updated on register and on message fetch
- No deregistration. No TTL. No heartbeat requirement.
- Server has no way to know if an agent is alive or dead

### Message Delivery
```
Sender → POST /messages → Server stores message → ???

Receiver picks up via ONE of:
  a) MCP poll (mesh_poll tool) — on-demand, agent must actively call
  b) Daemon poll (mesh-client.ts) — every 5s, injects into tmux
  c) Webhook push (server → HTTP POST) — instant, OpenClaw only
  d) CLI poll (meshterm poll) — manual
  e) TUI (auto-refresh) — visual only
```

### What the sender sees
- `{"ok": true, "message": {...}}` — message accepted by server
- No indication if recipient exists, is online, or will ever read it

## Proposed Design

### Phase 1: Agent Presence & Message States

**Agent presence:**
```
Agent states: online → idle → offline → expired

online:   last_seen < 30s (active heartbeat or recent activity)
idle:     last_seen 30s-5min (registered but quiet)  
offline:  last_seen > 5min (probably disconnected)
expired:  last_seen > 24h (stale, auto-cleanup candidate)
```

**Message delivery states:**
```
Message lifecycle: queued → delivered → read → expired

queued:     stored on server, recipient hasn't fetched
delivered:  recipient fetched the message (GET /messages/:agent returned it)
read:       recipient explicitly marked as read (PATCH /messages/:id/read)
expired:    TTL exceeded (e.g., 24h), auto-cleaned
```

**Sender feedback:**
- `POST /messages` returns `{ok, message, recipient_status: "online"|"idle"|"offline"|"unknown"}`
- Sender can decide: if offline, maybe queue for later or try a different agent
- New endpoint: `GET /messages/:id/status` — check delivery state of a sent message

### Phase 2: Per-Session Agent Identity

**Problem:** Multiple Kiro instances on the same machine all register as `kiro-mac`.

**Solution: Agent name = identity + session qualifier**

```
Registration: POST /agents/register {
  name: "kiro-mac",           // base identity
  session_id: "cli-a1b2c3",   // unique per session (auto-generated)
  type: "kiro",
  host: "macbook",
  context: "working on FDB audit"  // optional, human-readable
}

Server stores as: kiro-mac/cli-a1b2c3
```

**Addressing modes:**
```
meshterm send kiro-mac "task"                    → delivers to LATEST active session
meshterm send kiro-mac/cli-a1b2c3 "task"         → delivers to specific session
meshterm send kiro-mac --broadcast "pull latest"  → delivers to ALL sessions
```

**MCP server auto-generates session_id on startup:**
```typescript
// In MCP server init
const sessionId = `mcp-${Date.now().toString(36)}`;
const agentName = `${config.agent}/${sessionId}`;
```

**Backward compatible:** Messages to `kiro-mac` (no session qualifier) use "latest active" routing. Old agents that don't send session_id work as before.

### Phase 3: Delivery Mechanism Awareness

**Problem:** Sender doesn't know HOW the recipient receives messages. Sending to an MCP-only agent that never polls is effectively a black hole.

**Solution: Agent capabilities in registration**

```
POST /agents/register {
  name: "kiro-mac",
  receive_modes: ["mcp_poll"],        // how this agent receives
  // vs
  name: "kiro-vps", 
  receive_modes: ["daemon_push"],     // daemon injects into tmux
  // vs
  name: "kaze",
  receive_modes: ["webhook_push"],    // server pushes via webhook
}
```

**Server uses this for:**
- Warning sender: "recipient only receives via polling — delivery not guaranteed"
- Smart routing: if a role has both a daemon agent and an MCP agent, prefer the daemon agent (guaranteed delivery)
- Dashboard: show which agents have reliable receive vs best-effort

### Phase 4: Cleanup & Garbage Collection

**Auto-cleanup rules:**
```
- Agents with last_seen > 24h: mark as expired, exclude from routing
- Agents with last_seen > 7d: auto-deregister
- Messages older than 48h and still queued: mark as expired
- Messages older than 7d: delete
- Orphaned MCP processes: detect via PID file, kill on `meshterm agent cleanup`
```

**Manual cleanup:**
```
meshterm agent cleanup              # kill orphaned processes, deregister expired agents
meshterm agent deregister <name>    # explicit removal
meshterm messages cleanup           # purge expired messages
```

## Implementation Priority

| Phase | Effort | Impact | Dependency |
|-------|--------|--------|------------|
| 1: Message states + presence | Medium | High — sender finally knows if delivery worked | None |
| 2: Per-session identity | Medium | High — solves multi-instance collision | Phase 1 (presence) |
| 3: Delivery awareness | Small | Medium — better routing decisions | Phase 1 |
| 4: Cleanup/GC | Small | Medium — prevents state bloat | Phase 1 |

## Open Questions

1. **Should expired messages be retried or dropped?** Current: dropped silently. Proposed: configurable per-message TTL.
2. **Should the server actively ping agents?** Or rely on passive last_seen tracking? Active pinging adds complexity but gives real-time presence.
3. **WebSocket vs long-polling for MCP agents?** WebSocket would solve the MCP polling limitation but requires protocol changes. Long-polling is simpler but still requires the agent to initiate.
4. **Per-agent API keys** — currently one shared secret. Should each agent have its own key? This affects identity verification (can't impersonate another agent).

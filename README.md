# meshterm

Agent-agnostic communication layer for AI agents. If it has a terminal prompt, it's on the mesh.

```
┌──────────────┐                          ┌──────────────┐
│ Claude Code  │                          │              │
│   ↕ stdio    │                          │  Mesh Server │
│ MCP server   │ ─── HTTPS + API key ──→  │  (HTTP)      │
│ (local)      │                          │              │
└──────────────┘                          │  Messages    │
                                          │  Rooms       │
┌──────────────┐                          │  Roles       │
│ Kiro CLI     │                          │  Agents      │
│   ↕ stdio    │                          │              │
│ MCP server   │ ─── HTTPS + API key ──→  └──────┬───────┘
│ (local)      │                                 │
└──────────────┘                          ┌──────┴───────┐
                                          │ Any agent    │
┌──────────────┐                          │ (direct HTTP)│
│ Any TUI agent│                          └──────────────┘
│   ↕ tmux     │
│ daemon       │ ─── HTTPS + API key ──→
│ (background) │
└──────────────┘
```

## Sending vs Receiving

Every agent can **send** messages — just call the API (via MCP tool, CLI, or HTTP).

**Receiving** depends on the agent type:

| Agent Type | Receive Method | How | Real-time? |
|-----------|---------------|-----|-----------|
| MCP agent (Kiro, Claude, Cursor) | Agent polls | Agent calls `mesh_poll` MCP tool | ⚠️ On-demand |
| CLI in tmux | Daemon push | `meshterm daemon start` injects via `tmux send-keys` | ✅ Yes |
| OpenClaw | Webhook push | Server POSTs to OpenClaw webhook → triggers heartbeat | ✅ Yes |
| Any HTTP client | Poll API | `GET /messages/:agent?unread=true` | ⚠️ On-demand |

**In short:**
- MCP agents get tools to send freely, but only receive when they actively poll
- tmux agents get messages injected automatically by the daemon
- OpenClaw agents get messages pushed via webhook
- Any agent can always poll the REST API directly

## The Problem

You run multiple AI agents across multiple machines. They can't talk to each other. You copy-paste between them. You're the bottleneck.

## The Solution

meshterm is a lightweight, self-hosted message broker that lets any AI agent send tasks to any other agent. Zero code changes to the agent.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime
- [tmux](https://github.com/tmux/tmux) (for receiving messages — `brew install tmux` on macOS, `apt install tmux` on Linux)

### Step 1: Install meshterm

```bash
npm install -g meshterm
```

### Step 2: Deploy the server

Pick one:

```bash
# Option A: Docker (recommended)
git clone https://github.com/KenEzekiel/meshterm.git
cd meshterm/docker
echo "MESH_SECRET=$(openssl rand -hex 16)" > .env
docker compose up -d

# Option B: Bare
MESH_SECRET=your-secret meshterm server start
```

The server runs on port 4200. For remote access, put it behind a reverse proxy with SSL (nginx, Caddy, etc.).

### Step 3: Configure your machine

```bash
meshterm init --server https://your-server.com --key your-secret --agent my-agent
```

This creates `~/.meshterm/config.json`. Run this on every machine that connects to the mesh.

### Step 4: Connect your AI agent

```bash
# Auto-configure (recommended)
meshterm setup kiro --session my-tmux-session
# Also supports: claude, cursor, copilot, gemini

# This does three things:
# 1. Writes MCP config so the agent gets mesh tools
# 2. Writes a steering/skill file so the agent understands mesh messages
# 3. Starts the daemon to push incoming messages to the agent
```

Or configure manually:

```bash
# Start your agent in tmux
tmux new-session -d -s agent
tmux send-keys -t agent "your-agent-cli" Enter

# Start the daemon (background, pushes messages to tmux)
meshterm daemon start --agent my-agent --session agent

# Add MCP config to your agent (path varies by agent)
# ~/.kiro/settings/mcp.json, ~/.claude/mcp.json, etc.
{
  "mcpServers": {
    "meshterm": {
      "command": "meshterm",
      "args": ["mcp"]
    }
  }
}
```

### Step 5: Send your first message

```bash
meshterm send my-agent "hello from the mesh"
meshterm poll
```

That's it. Your agents can now talk to each other.

## Capabilities

### Three Integration Paths

| Path | How it works | Best for |
|------|-------------|----------|
| **MCP server** | Local stdio server, agent discovers tools automatically | Claude Code, Kiro, Cursor, Copilot, Gemini |
| **Daemon + tmux** | Background process injects messages into tmux sessions | Any TUI agent, agents without MCP |
| **Direct HTTP** | Call the REST API directly | API-native agents, scripts, OpenClaw |

### Two Communication Modes

**Messages (Orchestrational)** — 1:1 task delegation between agents.

```bash
meshterm send agent-1 "refactor the auth module"
meshterm poll  # check for replies
```

**Rooms (Discussional)** — multi-agent conversation spaces.

```bash
meshterm room create planning --members agent-1,agent-2,agent-3 --mode free-form
meshterm room send planning "Let's discuss the architecture"
meshterm room history planning
```

Room modes: `free-form` (anyone speaks), `round-robin` (take turns), `reactive` (respond when relevant), `moderated` (moderator controls flow).

### Role-Based Routing

Route messages to the best available agent by role instead of by name.

```bash
# Create a role
meshterm role create coder \
  --agents agent-1,agent-2 \
  --priority agent-1,agent-2 \
  --fallback queue

# Send to role (routes to best available agent)
meshterm send role:coder "fix the login bug"

# Broadcast to all agents in a role
meshterm send role:coder --broadcast "pull latest and rebuild"
```

Routing logic:
1. Check which agents in the role are online (heartbeat < 30s)
2. Pick the highest-priority online agent
3. If none online: `queue` (deliver when one comes online) or `reject` (return error)

### Daemon (Background Push)

The daemon runs in the background and pushes incoming messages into your agent's tmux session. No separate terminal needed.

```bash
meshterm daemon start --agent my-agent --session my-tmux
meshterm daemon status   # check if running
meshterm daemon stop     # stop it
```

- PID file: `~/.meshterm/daemon.pid`
- Log file: `~/.meshterm/daemon.log`
- Survives terminal close
- Auto-started by `meshterm setup`

### Auto-Setup

One command to configure any supported agent:

```bash
meshterm setup kiro     # Kiro CLI
meshterm setup claude   # Claude Code
meshterm setup cursor   # Cursor
meshterm setup copilot  # GitHub Copilot
meshterm setup gemini   # Gemini CLI
```

What it does:
- Writes MCP config to the agent's config path
- Writes a steering/skill file (for agents that support it)
- Starts the daemon with `--session` flag

### MCP Tools

When connected via MCP, agents get these tools automatically:

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to an agent or `role:xxx` |
| `mesh_reply` | Reply to a message |
| `mesh_poll` | Check for unread messages |
| `mesh_agents` | List online agents |
| `mesh_status` | Mesh health overview |
| `mesh_roles` | List available roles |
| `mesh_room_create` | Create a discussion room |
| `mesh_room_send` | Send message to a room |
| `mesh_room_history` | View room message history |
| `mesh_room_list` | List all rooms |
| `mesh_room_join` | Join a room |
| `mesh_room_leave` | Leave a room |

### TUI Dashboard

Live terminal dashboard showing agents, messages, and mesh status.

```bash
meshterm tui
```

- Agents panel with online/offline status
- Messages panel with recent activity
- Status bar with totals
- Auto-refresh every 3s
- Keyboard: `q` quit, `r` refresh, `tab` switch panels

### Agent Skills

Skill files teach agents how to handle mesh messages. Included for:

- `skills/kiro/SKILL.md` — Kiro CLI
- `skills/claude/SKILL.md` — Claude Code
- `skills/openclaw/SKILL.md` — OpenClaw

These are auto-installed by `meshterm setup`. For other agents, copy the relevant skill file to your agent's skill/steering directory.

## CLI Reference

| Command | Description |
|---------|-------------|
| `meshterm init` | Configure server URL, API key, agent name |
| `meshterm setup <agent>` | Auto-configure an AI agent (kiro/claude/cursor/copilot/gemini) |
| `meshterm send <to> <message>` | Send message (direct or `role:xxx`) |
| `meshterm send <to> --broadcast <msg>` | Broadcast to all agents in role |
| `meshterm poll` | Check for unread messages |
| `meshterm agents` | List registered agents |
| `meshterm status` | Show mesh health and overview |
| `meshterm roles` | List roles |
| `meshterm role create <name>` | Create a role with `--agents`, `--priority`, `--fallback` |
| `meshterm room create <name>` | Create a room with `--members`, `--mode` |
| `meshterm room list` | List rooms |
| `meshterm room send <name> <msg>` | Send to room |
| `meshterm room history <name>` | View room messages |
| `meshterm room join <name>` | Join a room |
| `meshterm room leave <name>` | Leave a room |
| `meshterm room close <name>` | Delete a room |
| `meshterm daemon start` | Start background daemon with `--agent`, `--session` |
| `meshterm daemon stop` | Stop the daemon |
| `meshterm daemon status` | Show daemon status |
| `meshterm tui` | Launch TUI dashboard |
| `meshterm mcp` | Start MCP server (stdio) |
| `meshterm server start` | Start the mesh server |
| `meshterm client start` | Start tmux inject client (foreground) |

## API Reference

All endpoints (except `/health`) require `x-mesh-secret` header.

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/register` | Register `{name, type, host}` |
| GET | `/agents` | List agents |

### Messages
| Method | Path | Description |
|--------|------|-------------|
| POST | `/messages` | Send `{from_agent, to_agent, body, broadcast?}` |
| GET | `/messages/:agent?unread=true` | Get messages for agent |
| PATCH | `/messages/:id/read` | Mark message read |
| GET | `/messages/:agent/history?limit=50` | Conversation history |

### Roles
| Method | Path | Description |
|--------|------|-------------|
| POST | `/roles` | Create/update `{name, agents, priority, fallback, capabilities}` |
| GET | `/roles` | List roles |
| GET | `/roles/:name` | Get role details |

### Rooms
| Method | Path | Description |
|--------|------|-------------|
| POST | `/rooms` | Create `{name, members, mode, moderator?}` |
| GET | `/rooms` | List rooms |
| GET | `/rooms/:name` | Get room details |
| DELETE | `/rooms/:name` | Close room |
| POST | `/rooms/:name/join` | Join `{agent}` |
| POST | `/rooms/:name/leave` | Leave `{agent}` |
| POST | `/rooms/:name/messages` | Send `{from_agent, body}` |
| GET | `/rooms/:name/messages?limit=50` | Room history |

## How It Works

```
Sender                    Server                    Receiver
  │                         │                         │
  │  POST /messages         │                         │
  │ ──────────────────────→ │  stores message         │
  │                         │                         │
  │                         │  daemon polls (5s)      │
  │                         │ ←────────────────────── │
  │                         │                         │
  │                         │  returns new messages   │
  │                         │ ──────────────────────→ │
  │                         │                         │
  │                         │  tmux send-keys         │
  │                         │  "[mesh:sender] msg"    │
  │                         │ ──────────────────────→ │
  │                         │                         │
  │                         │  agent processes task   │
  │                         │                         │
  │                         │  mesh_reply (MCP tool)  │
  │                         │ ←────────────────────── │
  │  GET /messages?unread   │                         │
  │ ──────────────────────→ │                         │
  │                         │                         │
  │  reply                  │                         │
  │ ←────────────────────── │                         │
```

The pipe is dumb. The agent is smart. meshterm just moves bytes between them.

## Docker

```bash
git clone https://github.com/KenEzekiel/meshterm.git
cd meshterm/docker
echo "MESH_SECRET=$(openssl rand -hex 16)" > .env
docker compose up -d
```

Port 4200, localhost only by default. For remote access, expose via reverse proxy with SSL.

The Docker container connects to the `npm_default` network if available (for nginx proxy manager integration).

## Networking

meshterm is just HTTP — the only question is "can your machines reach the server?"

### Same WiFi / LAN

```bash
# Machine A (server)
meshterm server start
# Find your local IP: ifconfig | grep 192

# Machine B (agent)
meshterm init --server http://192.168.x.x:4200 --key your-secret --agent my-agent
meshterm setup kiro --session kiro
```

### Different networks

**Option 1: Tailscale (recommended, free)**
```bash
# Install Tailscale on both machines
# Machine A starts server
meshterm server start

# Machine B connects via Tailscale IP
meshterm init --server http://100.x.x.x:4200 --key your-secret --agent my-agent
```

**Option 2: ngrok (quick tunnel)**
```bash
# Machine A
meshterm server start
ngrok http 4200
# → https://abc123.ngrok.io

# Machine B
meshterm init --server https://abc123.ngrok.io --key your-secret --agent my-agent
```

**Option 3: VPS (always online)**

Deploy the server on a VPS (Hetzner, DigitalOcean, etc.), put it behind a reverse proxy with SSL. Both machines connect to the public URL. Most reliable for persistent setups.

## Roadmap

- [x] HTTP message broker
- [x] tmux inject client
- [x] CLI (send, poll, agents, status, roles, rooms)
- [x] MCP server (13 tools)
- [x] Role-based routing with priority + fallback
- [x] Rooms (4 modes)
- [x] TUI dashboard
- [x] Background daemon
- [x] Auto-setup for 5 agents
- [x] npm published
- [ ] Message delivery states (queued → delivered → acknowledged)
- [ ] Per-agent API keys
- [ ] Structured error responses
- [ ] WebSocket push (replace polling)

## License

MIT

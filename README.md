# meshterm

[![npm version](https://img.shields.io/npm/v/meshterm.svg)](https://www.npmjs.com/package/meshterm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/KenEzekiel/meshterm/actions/workflows/ci.yml/badge.svg)](https://github.com/KenEzekiel/meshterm/actions/workflows/ci.yml)

Agent-agnostic communication layer for AI agents. If it has a terminal prompt, it's on the mesh. Self-hosted, lightweight HTTP message broker that lets any AI agent send tasks to any other agent — across machines, across tools, zero code changes.

> **Example:** You have Claude Code on your laptop and Kiro on your VPS. You want Claude to ask Kiro to deploy code. meshterm makes that possible — no code changes to either agent.

> **⚠️ Requires [Bun](https://bun.sh) runtime.** Install it first: `curl -fsSL https://bun.sh/install | bash`

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

> **Known limitation:** MCP agents (Kiro, Claude, Cursor) cannot receive messages in real-time. They must call `mesh_poll` to check for new messages. If no one polls, messages sit unread. The roadmap includes WebSocket push to fix this.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [tmux](https://github.com/tmux/tmux) (for receiving messages — `brew install tmux` on macOS, `apt install tmux` on Linux)

### 1. Install

```bash
npm install -g meshterm
```

### 2. Start the server

Run this on the machine that will be your central hub — a VPS for cross-network setups, or your laptop if all agents are local.

```bash
meshterm server start --port 4200 --secret your-secret
```

Or with environment variables:

```bash
MESH_PORT=4200 MESH_SECRET=your-secret meshterm server start
```

### 3. Configure your machine

```bash
meshterm init --server http://localhost:4200 --key your-secret --agent my-agent
```

This creates `~/.meshterm/config.json`. Run this on every machine that connects to the mesh.

### 4. Send your first message

```bash
meshterm send my-agent "hello from the mesh"
meshterm poll
```

That's it. Your agents can now talk to each other.

## Hello World — Your First Message

```bash
# Terminal 1: Start the server
meshterm server start --secret demo-secret

# Terminal 2: Configure and test
meshterm init --server http://localhost:4200 --key demo-secret --agent my-agent
meshterm send my-agent "hello from the mesh"
meshterm poll
# → 📨 my-agent: hello from the mesh
```

That's it — message sent, stored, and retrieved. In a real setup, you'd have agents on different machines (or different tmux sessions) talking to each other.

**Multiple agents on one machine:**

```bash
meshterm agent start --name alice --cli "kiro-cli chat" --session alice
meshterm agent start --name bob --cli "kiro-cli chat" --session bob

# Now alice and bob are in separate tmux sessions with their own mesh-client daemons.
# Send from anywhere:
meshterm send alice "review my PR"
# → Message injected into alice's tmux session automatically
```

## Connect Your Agents

After the server is running and you've run `meshterm init`, pick the setup that matches your agent:

### IDE agents (Kiro, Claude, Cursor, Copilot, Gemini)

Your agent runs inside an IDE or as a CLI chat. It **sends** via MCP tools and **receives** by polling.

**Full setup:**
```bash
# 1. Configure meshterm (once per machine)
meshterm init --server https://your-server:4200 --key your-secret --agent my-agent

# 2. Auto-configure your IDE agent
meshterm setup kiro
# Also supports: claude, cursor, copilot, gemini

# 3. Restart your IDE / start a new CLI session

# 4. Your agent now has these MCP tools:
#    mesh_send    — send a message to any agent
#    mesh_poll    — check for messages (shows recent history + read status)
#    mesh_read    — read full message by ID
#    mesh_reply   — reply to a message
#    mesh_agents  — see who's online
#    mesh_status  — mesh health overview
#    + 7 more (rooms, roles)
```

What `meshterm setup` creates:
- **MCP config** — adds meshterm MCP server to your IDE config
- **Steering file** — teaches the agent how to handle `[mesh:...]` messages

> **Note:** IDE agents can only receive messages when they actively call `mesh_poll`. They don't get messages pushed automatically. For push delivery, use a terminal agent.

### Terminal agents (tmux)

Your agent runs in a tmux session. It **sends** via MCP or CLI and **receives** messages pushed into its terminal automatically.

**Full setup:**
```bash
# 1. Configure meshterm (once per machine)
meshterm init --server https://your-server:4200 --key your-secret --agent my-agent

# 2. Start the agent (creates tmux + CLI + message daemon)
meshterm agent start --name my-agent --cli "kiro-cli chat" --session my-agent

# 3. Attach to the session
meshterm agent attach --name my-agent

# 4. Detach without stopping: Ctrl+B then D
```

What `meshterm agent start` does:
1. Creates a tmux session with the given name
2. Starts your CLI command inside it
3. Starts a background daemon that polls for messages every 5s
4. When a message arrives, the daemon types it into the tmux pane as `[mesh:sender] message`

**Managing terminal agents:**
```bash
meshterm agent list                                  # see running agents + status
meshterm agent attach --name my-agent                # attach to tmux session
meshterm agent stop --name my-agent                  # stop daemon (keeps tmux)
meshterm agent stop --name my-agent --kill-session   # stop daemon + kill tmux
```

**After a reboot:** The daemon doesn't survive restarts. Run `agent start` again — it detects the existing tmux session and only restarts the daemon:
```bash
meshterm agent start --name my-agent --cli "kiro-cli chat" --session my-agent
# → "Tmux session already exists — skipping CLI launch"
# → Daemon restarted
```

> **Already have a tmux session running?** `agent start` detects it and skips the CLI launch. It only starts the daemon. Safe to run on existing sessions.

### Webhook agents (OpenClaw, Slack, Discord)

Your agent receives messages via HTTP webhook push — instant delivery, no polling.

Configure in `mesh-config.json` (place next to the server):

```json
{
  "webhooks": {
    "my-agent": {
      "url": "https://your-webhook-url",
      "token": "your-token",
      "format": "raw"
    }
  }
}
```

Built-in formats: `raw`, `openclaw`, `slack`, `discord`, `custom` (with `{{from}}`, `{{to}}`, `{{body}}` templates).

Or via environment variable: `MESH_WEBHOOKS="agent|url|token" meshterm server start`

## Communication Modes

### Messages — 1:1 task delegation

```bash
meshterm send agent-1 "refactor the auth module"
meshterm poll  # check for replies
```

### Rooms — multi-agent conversations

```bash
meshterm room create planning --members agent-1,agent-2,agent-3 --mode free-form
meshterm room send planning "Let's discuss the architecture"
meshterm room history planning
```

Room modes: `free-form` (anyone speaks), `round-robin` (take turns), `reactive` (respond when relevant), `moderated` (moderator controls flow).

### Role-Based Routing

Route messages to the best available agent by role instead of by name:

```bash
meshterm role create coder \
  --agents agent-1,agent-2 \
  --priority agent-1,agent-2 \
  --fallback queue

meshterm send role:coder "fix the login bug"
meshterm send role:coder --broadcast "pull latest and rebuild"
```

Routing logic:
1. Check which agents in the role are online (heartbeat < 30s)
2. Pick the highest-priority online agent
3. If none online: `queue` (deliver when one comes online) or `reject` (return error)

## MCP Tools

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

## CLI Reference

### Getting Started

| Command | Description |
|---------|-------------|
| `meshterm init` | Configure server URL, API key, agent name |
| `meshterm setup <agent>` | **One-command setup for IDE agents** (kiro/claude/cursor/copilot/gemini). Writes MCP config, steering file, starts daemon. |
| `meshterm agent start` | **One-command setup for terminal agents.** Creates tmux session, starts CLI, starts mesh-client. (`--name`, `--cli`, `--session`) |
| `meshterm agent stop` | Stop a terminal agent cleanly (`--name`, `--kill-session`) |
| `meshterm agent list` | Show running agents with status |

> **Which do I use?**
> - IDE agent (Kiro, Claude, Cursor)? → `meshterm init` then `meshterm setup kiro`
> - Terminal agent in tmux? → `meshterm init` then `meshterm agent start --name my-agent --cli "kiro-cli chat" --session my-agent`

### Messaging

| Command | Description |
|---------|-------------|
| `meshterm send <to> <message>` | Send message (direct or `role:xxx`, `--broadcast` for roles) |
| `meshterm poll` | Check for unread messages |
| `meshterm agents` | List registered agents |
| `meshterm status` | Show mesh health and overview |

### Rooms

| Command | Description |
|---------|-------------|
| `meshterm room create <name>` | Create a room (`--members`, `--mode`) |
| `meshterm room list` | List rooms |
| `meshterm room send <name> <msg>` | Send to room |
| `meshterm room history <name>` | View room messages (`--limit`) |
| `meshterm room join/leave/close <name>` | Manage room membership |

### Roles

| Command | Description |
|---------|-------------|
| `meshterm roles` | List roles |
| `meshterm role create <name>` | Create a role (`--agents`, `--priority`, `--fallback`) |

### Server

| Command | Description |
|---------|-------------|
| `meshterm server start` | Start the mesh server (`--port`, `--secret`, `--store`) |

### Advanced / Low-Level

These are building blocks used by `setup` and `agent start`. You typically don't need them directly.

| Command | Description | When to use |
|---------|-------------|-------------|
| `meshterm daemon start` | Start background message injection daemon | Already have a tmux session, just need message push |
| `meshterm daemon stop/status` | Manage the daemon | Debugging daemon issues |
| `meshterm client start` | Foreground daemon (blocks terminal) | Debugging message injection |
| `meshterm mcp` | Start MCP server (stdio) | Custom MCP integration, not using `setup` |
| `meshterm tui` | Launch terminal dashboard | Visual overview of agents, messages, rooms |

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

## Self-Hosting with Docker

If you prefer Docker over running the server directly:

```bash
git clone https://github.com/KenEzekiel/meshterm.git
cd meshterm/docker
echo "MESH_SECRET=$(openssl rand -hex 16)" > .env
docker compose up -d
```

Port 4200, localhost only by default. For remote access, expose via reverse proxy with SSL.

The Docker container connects to the `npm_default` network if available (for nginx proxy manager integration).

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

## Networking

meshterm is just HTTP — the only question is "can your machines reach the server?"

### Same WiFi / LAN

```bash
# Machine A (server)
meshterm server start --secret your-secret

# Machine B (agent)
meshterm init --server http://192.168.x.x:4200 --key your-secret --agent my-agent
meshterm setup kiro --session kiro
```

### Different networks

**Option 1: Tailscale (recommended, free)**
```bash
# Install Tailscale on both machines
meshterm server start --secret your-secret        # Machine A
meshterm init --server http://100.x.x.x:4200 ...  # Machine B
```

**Option 2: ngrok (quick tunnel)**
```bash
meshterm server start --secret your-secret  # Machine A
ngrok http 4200                              # → https://abc123.ngrok.io
meshterm init --server https://abc123.ngrok.io ...  # Machine B
```

**Option 3: VPS (always online)**

Deploy the server on a VPS (Hetzner, DigitalOcean, etc.), put it behind a reverse proxy with SSL. Both machines connect to the public URL. Most reliable for persistent setups.

## Security Model

meshterm is designed for **trusted agent networks** — all agents on the mesh share a single secret and can send messages to each other. Understand these tradeoffs:

**Trust model:** Any agent with the mesh secret can send messages to any other agent. Messages injected into tmux sessions execute as keystrokes. Only connect agents you trust.

**What's protected:**
- Timing-safe secret comparison (prevents timing attacks)
- Message size limits (100KB max per message)
- Secrets passed via environment variables, not CLI args
- Docker binds to localhost only by default
- Zero dependencies (no supply chain attack surface)

**What's your responsibility:**
- Use a reverse proxy with SSL for remote deployments (HTTP by default)
- Keep your mesh secret secure — rotate it if compromised
- Only connect agents you control to the mesh
- The steering file tells agents to treat mesh messages as tasks — this is by design

**Roadmap:** Per-agent API keys, rate limiting.

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

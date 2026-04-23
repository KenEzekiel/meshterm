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

## Hello World — Two Agents in 5 Minutes

This walks through two agents on the same machine exchanging a message.

```bash
# Terminal 1: Start the server
meshterm server start --secret demo-secret

# Terminal 2: Configure agent "alice"
meshterm init --server http://localhost:4200 --key demo-secret --agent alice

# Terminal 3: Configure agent "bob"
MESHTERM_CONFIG_DIR=/tmp/bob-mesh meshterm init --server http://localhost:4200 --key demo-secret --agent bob

# Terminal 2 (alice): Send a message to bob
meshterm send bob "Hey bob, can you review my PR?"

# Terminal 3 (bob): Check for messages
MESHTERM_CONFIG_DIR=/tmp/bob-mesh meshterm poll
# → [mesh:alice] Hey bob, can you review my PR?

# Terminal 3 (bob): Reply
MESHTERM_CONFIG_DIR=/tmp/bob-mesh meshterm send alice "Sure, LGTM 👍"

# Terminal 2 (alice): Check reply
meshterm poll
# → [mesh:bob] Sure, LGTM 👍
```

## Connect Your Agents

### MCP agents (Kiro, Claude, Cursor, Copilot, Gemini)

One command auto-configures MCP config, steering/skill files, and the daemon:

```bash
meshterm setup kiro --session my-tmux-session
# Also supports: claude, cursor, copilot, gemini
```

This creates:
- **MCP config** — adds meshterm server to `~/.kiro/settings/mcp.json` (or equivalent for other agents)
- **Steering/skill file** — teaches the agent how to use mesh tools and handle `[mesh:...]` messages
- **Daemon** — starts a background process that pushes incoming messages to the tmux session

Or configure manually — add to your agent's MCP config (`~/.kiro/settings/mcp.json`, `~/.claude/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "meshterm": {
      "command": "meshterm",
      "args": ["mcp"]
    }
  }
}
```

### tmux agents (daemon push)

For any TUI agent running in tmux:

```bash
# Start your agent in tmux
tmux new-session -d -s agent
tmux send-keys -t agent "your-agent-cli" Enter

# Start the daemon (background, pushes messages to tmux)
meshterm daemon start --agent my-agent --session agent
```

### OpenClaw (webhook push)

Configure webhooks on the server via a config file or environment variable. meshterm supports multiple webhook formats via adapters:

**Config file** (`mesh-config.json` next to the server, or set `MESH_CONFIG` env):

```json
{
  "webhooks": {
    "my-openclaw-agent": {
      "url": "https://your-openclaw-url/webhook",
      "token": "your-token",
      "format": "openclaw"
    },
    "slack-notifications": {
      "url": "https://hooks.slack.com/services/xxx",
      "format": "slack"
    },
    "custom-service": {
      "url": "https://your-api.com/hook",
      "token": "bearer-token",
      "format": "custom",
      "template": "{\"event\": \"mesh_message\", \"from\": \"{{from}}\", \"text\": \"{{body}}\"}"
    }
  }
}
```

**Built-in adapters:**

| Format | Payload | Use case |
|--------|---------|----------|
| `raw` | `{from_agent, to_agent, body, created_at, id}` | Generic webhooks, custom integrations |
| `openclaw` | `{text: "[meshterm] Message from ...", mode: "now"}` | OpenClaw gateway |
| `slack` | `{text: "*[meshterm]* Message from agent: ..."}` | Slack incoming webhooks |
| `discord` | `{content: "**[meshterm]** Message from agent: ..."}` | Discord webhooks |
| `custom` | User-defined template with `{{from}}`, `{{to}}`, `{{body}}`, `{{timestamp}}` | Anything else |

**Environment variable** (backward compatible, defaults to `openclaw` format):

```bash
MESH_WEBHOOKS="agent-name|https://webhook-url|token" meshterm server start
```

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

| Command | Description |
|---------|-------------|
| **Setup** | |
| `meshterm init` | Configure server URL, API key, agent name |
| `meshterm setup <agent>` | Auto-configure an AI agent (kiro/claude/cursor/copilot/gemini) |
| **Messaging** | |
| `meshterm send <to> <message>` | Send message (direct or `role:xxx`, `--broadcast` for roles) |
| `meshterm poll` | Check for unread messages |
| `meshterm agents` | List registered agents |
| `meshterm status` | Show mesh health and overview |
| **Rooms** | |
| `meshterm room create <name>` | Create a room with `--members`, `--mode` |
| `meshterm room list` | List rooms |
| `meshterm room send <name> <msg>` | Send to room |
| `meshterm room history <name>` | View room messages (`--limit`) |
| `meshterm room join <name>` | Join a room |
| `meshterm room leave <name>` | Leave a room |
| `meshterm room close <name>` | Delete a room |
| **Roles** | |
| `meshterm roles` | List roles |
| `meshterm role create <name>` | Create a role with `--agents`, `--priority`, `--fallback` |
| **Server** | |
| `meshterm server start` | Start the mesh server (`--port`, `--secret`, `--store`) |
| **Client** | |
| `meshterm client start` | Start tmux inject client (foreground, `--agent`, `--session`) |
| `meshterm daemon start` | Start background daemon (`--agent`, `--session`) |
| `meshterm daemon stop` | Stop the daemon |
| `meshterm daemon status` | Show daemon status |
| **Tools** | |
| `meshterm tui` | Launch terminal dashboard |
| `meshterm mcp` | Start MCP server (stdio) |

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

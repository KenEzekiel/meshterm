# meshterm

Agent-agnostic communication layer for AI agents. If it has a terminal prompt, it's on the mesh.

```
┌──────────────┐                          ┌──────────────┐
│ Kiro CLI     │                          │ Mesh Server  │
│   ↕ stdio    │                          │ (HTTP broker)│
│ MCP server   │ ─── HTTPS + API key ──→  │ :4200        │
│ (local)      │                          │              │
└──────────────┘                          │  Messages    │
                                          │  Rooms       │
┌──────────────┐                          │  Roles       │
│ Claude Code  │                          │  Agents      │
│   ↕ stdio    │                          └──────────────┘
│ MCP server   │ ─── HTTPS + API key ──→        ↑
│ (local)      │                          ┌─────┴────────┐
└──────────────┘                          │ OpenClaw     │
                                          │ (direct HTTP)│
┌──────────────┐                          └──────────────┘
│ Any TUI agent│
│   ↕ tmux     │
│ mesh-client  │ ─── HTTPS + API key ──→
│ (inject-only)│
└──────────────┘
```

## The Problem

You run multiple AI agents across multiple machines. They can't talk to each other. You copy-paste between them. You're the bottleneck.

## The Solution

meshterm is a lightweight, self-hosted message broker that lets any AI agent send tasks to any other agent. Zero code changes to the agent.

**Three integration paths:**
1. **MCP server** — local stdio, works with Claude Code, Kiro, Cursor, Copilot, Gemini
2. **tmux client** — inject-only poller for any TUI agent
3. **Direct HTTP** — for API-native agents like OpenClaw

**Two communication modes:**
1. **Messages** — 1:1 task delegation (orchestrational)
2. **Rooms** — multi-agent discussion spaces (discussional)

## Quick Start

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/KenEzekiel/meshterm/main/install.sh | bash
```

### 2. Start the server

```bash
# Bare
MESH_SECRET=your-secret meshterm server start

# Docker
cd docker && echo "MESH_SECRET=your-secret" > .env && docker compose up -d
```

### 3. Configure

```bash
meshterm init --server https://mesh.example.com --key your-secret --agent kaze
```

### 4. Connect agents

**Via MCP (Claude Code, Kiro, Cursor, etc.):**
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

**Via tmux (any TUI agent):**
```bash
tmux new-session -d -s kiro
tmux send-keys -t kiro "kiro-cli chat" Enter
meshterm client start --agent kiro-mac --session kiro
```

### 5. Send messages

```bash
# Direct
meshterm send kiro-mac "refactor the auth module"

# Role-based
meshterm send role:coder "refactor the auth module"

# Broadcast to all coders
meshterm send role:coder --broadcast "pull latest and rebuild"

# Check replies
meshterm poll
```

## Features

### Messages (Orchestrational)
Point-to-point task delegation between agents.

```bash
meshterm send kiro-mac "review PR #42"
meshterm poll
```

### Roles
Route messages to the best available agent by role.

```bash
# Create a role
meshterm role create coder --agents kiro-mac,kiro-vps --priority kiro-mac,kiro-vps --fallback queue

# Send to role (routes to best available)
meshterm send role:coder "fix the login bug"

# Broadcast to all agents in role
meshterm send role:coder --broadcast "git pull && rebuild"
```

### Rooms (Discussional)
Multi-agent conversation spaces with configurable modes.

```bash
# Create a room
meshterm room create code-review --members kiro-mac,claude-vps,kaze --mode free-form

# Send to room (all members see it)
meshterm room send code-review "review PR #42, focus on security"

# View history
meshterm room history code-review
```

Room modes: `free-form`, `round-robin`, `reactive`, `moderated`

### TUI Dashboard
Live terminal dashboard showing agents, messages, and status.

```bash
meshterm tui
```

### MCP Server
Local stdio MCP server — any MCP-compatible agent gets mesh access automatically.

Tools: `mesh_send`, `mesh_reply`, `mesh_poll`, `mesh_agents`, `mesh_status`, `mesh_roles`, `mesh_room_create`, `mesh_room_send`, `mesh_room_history`, `mesh_room_join`, `mesh_room_leave`, `mesh_room_list`

## CLI Reference

| Command | Description |
|---------|-------------|
| `meshterm init` | Configure server URL, API key, agent name |
| `meshterm send <to> <message>` | Send message (direct or `role:xxx`) |
| `meshterm send <to> --broadcast <msg>` | Broadcast to all agents in role |
| `meshterm poll` | Check for unread messages |
| `meshterm agents` | List registered agents |
| `meshterm status` | Show mesh health and overview |
| `meshterm roles` | List roles |
| `meshterm role create <name>` | Create a role |
| `meshterm room create <name>` | Create a room |
| `meshterm room list` | List rooms |
| `meshterm room send <name> <msg>` | Send to room |
| `meshterm room history <name>` | View room messages |
| `meshterm room join <name>` | Join a room |
| `meshterm room leave <name>` | Leave a room |
| `meshterm room close <name>` | Delete a room |
| `meshterm tui` | Launch TUI dashboard |
| `meshterm mcp` | Start MCP server (stdio) |
| `meshterm server start` | Start the mesh server |
| `meshterm client start` | Start tmux inject client |

## API Reference

All endpoints (except `/health`) require `x-mesh-secret` header.

### Messages
| Method | Path | Description |
|--------|------|-------------|
| POST | `/messages` | Send message `{from_agent, to_agent, body, broadcast?}` |
| GET | `/messages/:agent?unread=true` | Get messages for agent |
| PATCH | `/messages/:id/read` | Mark message read |
| GET | `/messages/:agent/history?limit=50` | Conversation history |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/register` | Register `{name, type, host}` |
| GET | `/agents` | List agents |

### Roles
| Method | Path | Description |
|--------|------|-------------|
| POST | `/roles` | Create/update role |
| GET | `/roles` | List roles |
| GET | `/roles/:name` | Get role details |

### Rooms
| Method | Path | Description |
|--------|------|-------------|
| POST | `/rooms` | Create room `{name, members, mode}` |
| GET | `/rooms` | List rooms |
| GET | `/rooms/:name` | Get room details |
| DELETE | `/rooms/:name` | Close room |
| POST | `/rooms/:name/join` | Join `{agent}` |
| POST | `/rooms/:name/leave` | Leave `{agent}` |
| POST | `/rooms/:name/messages` | Send `{from_agent, body}` |
| GET | `/rooms/:name/messages?limit=50` | Room history |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |

## Agent Skills

Skill files teach agents how to use the mesh:
- `skills/kiro/SKILL.md` — Kiro CLI
- `skills/claude/SKILL.md` — Claude Code
- `skills/openclaw/SKILL.md` — OpenClaw

## Docker

```bash
cd docker
echo "MESH_SECRET=your-secret" > .env
docker compose up -d
```

Port 4200. Expose via reverse proxy with SSL for remote access.

## How It Works

1. **Server** stores messages, rooms, roles, and agent registrations
2. **MCP server** (local) translates tool calls into mesh HTTP requests
3. **mesh-client** polls the server, injects messages into tmux sessions
4. Agents reply via MCP tools or `mesh-reply.sh`

The pipe is dumb. The agent is smart. meshterm just moves bytes between them.

## License

MIT

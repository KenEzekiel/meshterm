# meshterm

Agent-agnostic communication layer for AI agents. If it has a terminal prompt, it's on the mesh.

```
┌──────────────┐                          ┌──────────────┐
│ Kiro CLI     │                          │ Mesh Server  │
│   ↕ stdio    │                          │ (HTTP broker)│
│ MCP server   │ ─── HTTPS + API key ──→  │ :4200        │
│ (local)      │                          │              │
└──────────────┘                          │  Messages    │
                                          │  Agents      │
┌──────────────┐                          │  Auth        │
│ Claude Code  │                          └──────────────┘
│   ↕ stdio    │                                ↑
│ MCP server   │ ─── HTTPS + API key ──→        │
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

Three integration paths:
1. **MCP server** (coming soon) — local stdio, works with Claude Code, Kiro, Cursor, Copilot, Gemini
2. **tmux client** — inject-only poller for any TUI agent
3. **Direct HTTP** — for API-native agents like OpenClaw

## Quick Start

### 1. Install

```bash
# One-liner
curl -fsSL https://raw.githubusercontent.com/KenEzekiel/meshterm/main/install.sh | bash

# Or manually
git clone https://github.com/KenEzekiel/meshterm.git
cd meshterm
```

### 2. Start the server

```bash
# Bare
MESH_SECRET=your-secret meshterm server start

# Docker
cd docker && docker compose up -d
```

### 3. Configure a client

```bash
meshterm init --server https://mesh.example.com --key your-secret --agent kaze
```

### 4. Connect a TUI agent via tmux

```bash
# Start your agent in tmux
tmux new-session -d -s kiro
tmux send-keys -t kiro "kiro-cli chat" Enter

# Start the mesh client
meshterm client start --agent kiro-mac --session kiro
```

### 5. Send messages

```bash
# From CLI
meshterm send kiro-mac "refactor the auth module"

# Check for replies
meshterm poll

# See all agents
meshterm agents

# Full status
meshterm status
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `meshterm init` | Configure server URL, API key, agent name |
| `meshterm send <to> <message>` | Send a message to an agent |
| `meshterm poll` | Check for unread messages |
| `meshterm agents` | List registered agents |
| `meshterm status` | Show mesh health, agents, pending messages |
| `meshterm server start` | Start the mesh server |
| `meshterm client start` | Start the tmux inject client |

## API Reference

All endpoints (except `/health`) require `x-mesh-secret` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/agents/register` | Register agent `{name, type, host}` |
| GET | `/agents` | List agents |
| POST | `/messages` | Send message `{from_agent, to_agent, body}` |
| GET | `/messages/:agent?unread=true` | Get messages for agent |
| PATCH | `/messages/:id/read` | Mark message read |
| GET | `/messages/:agent/history?limit=50` | Conversation history |

## Agent Skills

meshterm includes skill files that teach agents how to use the mesh:

- `skills/kiro/SKILL.md` — Kiro CLI integration
- `skills/claude/SKILL.md` — Claude Code integration
- `skills/openclaw/SKILL.md` — OpenClaw integration

Copy the relevant skill file to your agent's skill directory.

## Docker

```bash
cd docker
echo "MESH_SECRET=your-secret" > .env
docker compose up -d
```

The server runs on port 4200. Expose via reverse proxy (nginx, Caddy) with SSL for remote access.

## How It Works

1. **Server** stores messages and agent registrations
2. **mesh-client** polls the server, injects messages into the agent's tmux session as `[mesh:sender] message`
3. Agent processes the task and replies via `mesh-reply.sh` (posts back to the server)
4. Sender polls and reads the reply

The pipe is dumb. The agent is smart. meshterm just moves bytes between them.

## Competitive Landscape

| Tool | Approach | meshterm difference |
|------|----------|-------------------|
| agentmux.app | Paid, local-only | Open source, cross-machine, free |
| buildoak/agent-mux | Engine-specific integrations | Truly agent-agnostic |
| AgentPipe | Agent debate rooms | Task delegation + discussion |
| AgentBus | SaaS broker | Self-hosted, no vendor lock-in |

## Roadmap

- [x] HTTP message broker
- [x] tmux inject client
- [x] CLI (send, poll, agents, status)
- [x] Agent skill files
- [ ] MCP server (local stdio)
- [ ] Role-based routing (`role:coder`)
- [ ] Rooms (multi-agent discussions)
- [ ] TUI dashboard
- [ ] npm publish

## License

MIT

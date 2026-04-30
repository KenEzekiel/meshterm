# Operations Guide

How to update, restart, and maintain meshterm components.

## Components Overview

| Component | What it does | Where it runs |
|-----------|-------------|---------------|
| **CLI + MCP** | Send/receive messages, MCP tools for IDEs | Your machine (npm) |
| **Agent** | tmux session + daemon that delivers messages | Your machine |
| **Server** | HTTP message broker | VPS (Docker) |
| **meshterm.live** | Managed service — provision API + tenant containers | Separate VPS |

## Updating

### CLI / MCP / Agent (any machine)

```bash
npm update -g meshterm
meshterm --version  # verify
```

Then restart the agent to pick up new code:

```bash
meshterm agent stop --name <agent-name>
meshterm agent start --name <agent-name> --cli "<your-cli>" --session <tmux-session>
```

MCP tools restart automatically when your IDE reconnects.

### Server (self-hosted, Docker)

```bash
ssh <your-vps>
cd ~/meshterm  # where docker-compose.yml lives
git pull
docker compose up -d --build
```

Messages in flight are preserved (stored in the JSON file / volume).

### meshterm.live tenant servers

Existing tenant containers keep running their version. Only new provisions get the updated image.

To update the image:

```bash
ssh root@<meshterm-live-vps>
# Copy updated server.ts + telemetry.ts to /opt/meshterm-server/
docker build -t meshterm-server /opt/meshterm-server/
# New provisions now use the updated image
```

To update an existing tenant (if needed):

```bash
docker stop meshterm-tenant-<id>
docker rm meshterm-tenant-<id>
# Re-provision via API or manually re-run with same port/secret
```

## Agent Management

```bash
meshterm agent list                    # show running agents
meshterm agent start --name <n> --cli "<cmd>" --session <s>
meshterm agent stop --name <n>
meshterm agent attach --name <n>       # attach to tmux session
tmux attach -t <session>               # or attach directly
```

## Profiles

Multiple configs on one machine:

```bash
meshterm init --profile work           # separate config
meshterm status --profile work
meshterm send --profile work <to> <msg>
```

Profiles are stored at `~/.meshterm/profiles/<name>.json`.

MCP agents select a profile via env var:

```json
{
  "env": { "MESHTERM_PROFILE": "work" }
}
```

## Troubleshooting

**Agent shows `⚠️ no mesh-client`:** The daemon died. Stop and restart the agent.

**`meshterm agent list` doesn't show a running agent:** The agent was started outside of `meshterm agent start`. Restart it via the command to register it.

**Lost your meshterm.live secret:** Anonymous servers can't be recovered. Provision a new one with `meshterm init`.

**MCP tools not working in IDE:** Restart the IDE or run `MCP: List Servers` → restart meshterm.

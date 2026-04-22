# meshterm daemon

Background process that automatically injects incoming mesh messages into a tmux session.

## Usage

```bash
# Start daemon
meshterm daemon start --agent kiro-mac --session kiro

# Check status
meshterm daemon status

# Stop daemon
meshterm daemon stop
```

## Implementation

### Files
- `~/.meshterm/daemon.pid` - Process ID
- `~/.meshterm/daemon.log` - stdout/stderr logs
- `~/.meshterm/daemon.json` - Daemon metadata (agent, session, start time)

### Features
- Detached process (survives parent exit)
- Automatic stale PID cleanup
- Status shows: running/stopped, PID, agent, session, uptime
- Logs redirected to `~/.meshterm/daemon.log`

### Auto-start on setup
When running `meshterm setup <agent-type>`, you'll be prompted for a tmux session name. The daemon will auto-start after configuration.

```bash
meshterm setup kiro --session kiro
# Writes MCP config, steering file, AND starts daemon
```

## How it works

The daemon spawns `mesh-client.ts` as a detached background process:
1. Polls mesh server for unread messages
2. Injects messages into tmux session with `[mesh:<agent>]` prefix
3. Marks messages as read
4. Runs continuously until stopped

## Edge cases handled
- Daemon already running → error
- PID file exists but process dead → cleanup stale files
- tmux session doesn't exist → mesh-client will log errors

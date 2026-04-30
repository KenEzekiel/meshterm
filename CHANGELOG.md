# Changelog

All notable changes to meshterm will be documented in this file.

## [0.15.0] - 2026-04-30

### Added
- **Named profiles** — `meshterm init --profile work` saves to `~/.meshterm/profiles/work.json`
- `--profile` flag and `MESHTERM_PROFILE` env var for all commands and MCP
- Overwrite guard on `meshterm init` — warns before replacing existing config
- `--force` flag to skip the guard

### Fixed
- npm `bin` entry pointed to `.ts` file (npm silently stripped it on publish). Created `bin/meshterm.mjs` wrapper — `npm install -g meshterm` now works correctly.

## [0.14.0] - 2026-04-30

### Added
- **meshterm Cloud** — free managed servers at meshterm.live
- `meshterm init` with blank server URL auto-provisions a free server
- CLI banner on `meshterm server start` promoting meshterm.live
- Provision API at `api.meshterm.live` — spins up isolated Docker containers per tenant
- Traefik reverse proxy with wildcard SSL on `*.meshterm.live`
- Reaper cron — pauses idle servers after 30 days, deletes after 60

## [0.13.0] - 2026-04-30

### Added
- **Message threading** — `reply_to` field on messages
- `mesh_reply` MCP tool accepts optional `in_reply_to` parameter
- `mesh_read` added to steering tool list
- Daemon injects messages as `[mesh:sender#msgid]` (includes message ID)
- Steering teaches agents about `user:` prefix — human messages get highest priority

## [0.12.0] - 2026-04-29

### Added
- **`MESHTERM_AGENT` env var** — override agent name per MCP instance
- Multiple agents on one machine with unique identities
- `meshterm setup` auto-generates `<type>-<agent>` names (e.g., `kiro-mac`, `copilot-mac`, `cursor-mac`)
- Anonymous telemetry (opt-out via `MESHTERM_TELEMETRY=0` or `config.telemetry=false`)

### Fixed
- `meshterm setup copilot` — correct VS Code path (`~/Library/.../Code/User/mcp.json` on macOS, `%APPDATA%/Code/User` on Windows) and `servers` key instead of `mcpServers`
- Daemon spawn in compiled binary mode

## [0.11.0] - 2026-04-24

### Added
- Security hardening: timing-safe auth (`crypto.timingSafeEqual`), 100KB message body limit
- Secret passed via `MESH_SECRET` env var (not CLI arg)
- Security Model section in README

### Fixed
- tmux detection — proper path resolution + `.status` instead of `.exitCode`
- Agent start skips CLI launch if tmux session already exists

## [0.10.0] - 2026-04-23

### Added
- Message states (`queued` → `fetched`) with timestamps
- Heartbeat endpoint for agent liveness
- Message status endpoint
- Source field on room message copies
- Recipient info on send response
- Room mode enforcement (round-robin turn order, moderated access control)
- `mesh_read` MCP tool + message IDs in `mesh_poll`

## [0.9.0] - 2026-04-23

### Added
- Agent lifecycle in CLI (`meshterm agent start/stop/list/attach`)

## [0.8.0] - 2026-04-23

### Added
- Webhook adapter pattern — 5 built-in formats: `raw`, `openclaw`, `slack`, `discord`, `custom`
- Server config file support (`mesh-config.json`) for webhook configuration
- Hello World end-to-end example in README
- MCP polling limitation documented

### Fixed
- `spawn("bun")` → `spawn(process.execPath)` — fixes MCP, TUI, and server subcommands in non-bun-PATH environments
- `mesh-reply.sh` reads from `~/.meshterm/config.json` instead of hardcoded defaults
- Removed all hardcoded personal agent names from codebase

### Changed
- Docker compose no longer includes VPS-specific networks (use `docker-compose.override.yml`)
- npm package only publishes `packages/`, `skills/`, `README.md`, `LICENSE`
- Webhook env var (`MESH_WEBHOOKS`) now defaults to `openclaw` format for backward compatibility

## [0.7.0] - 2026-04-23

### Added
- Agent lifecycle management (`meshterm agent start/stop/list`)
- OpenClaw skill improvements and receive path documentation

### Fixed
- Removed hardcoded mesh URL and secret from committed files

## [0.6.4] - 2026-04-22

### Fixed
- Webhook uses `/hooks/wake` instead of `/hooks/agent`

## [0.6.2] - 2026-04-22

### Fixed
- Client v3.1: mark read after inject, retry only on failure

## [0.6.0] - 2026-04-21

### Added
- Webhook push for OpenClaw
- Networking section in README

## [0.5.1] - 2026-04-21

### Added
- `user:` prefix for human-sent messages

## [0.5.0] - 2026-04-21

### Added
- TUI polish: compose, create room, unread highlights, new message badge

## [0.4.3] - 2026-04-20

### Fixed
- TUI: word-wrap long messages in chat/room views

## [0.4.2] - 2026-04-20

### Fixed
- Room reply routing in skills and steering
- TUI key fixes

## [0.4.0] - 2026-04-20

### Added
- TUI v2: interactive chat, room view, scrolling, send from TUI

## [0.3.2] - 2026-04-19

### Fixed
- Room messages create direct messages for daemon delivery

## [0.3.1] - 2026-04-19

### Fixed
- Daemon blocking terminal — close log fd after spawn

## [0.3.0] - 2026-04-19

### Added
- Daemon command + auto-start in setup

## [0.2.2] - 2026-04-18

### Fixed
- Kiro MCP config path: `~/.kiro/settings/mcp.json`

## [0.2.0] - 2026-04-18

### Added
- `meshterm setup` command — auto-configure any AI agent
- Role-based routing with priority and fallback
- Rooms — multi-agent discussion spaces (4 modes)
- MCP server (13 tools)
- TUI dashboard

## [0.1.0] - 2026-04-17

### Added
- Initial release — restructured from agent-mesh
- Unified CLI with all commands
- HTTP message broker (server)
- tmux inject client
- Skills for Kiro, Claude, OpenClaw
- Docker support
- npm published

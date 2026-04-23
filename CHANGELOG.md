# Changelog

All notable changes to meshterm will be documented in this file.

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

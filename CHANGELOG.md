# meshterm

Restructured from agent-mesh into a proper package structure.

## Structure

```
meshterm/
├── packages/
│   ├── server/
│   │   └── server.ts          # HTTP message broker (copied from agent-mesh)
│   ├── client/
│   │   ├── mesh-client.ts     # tmux inject poller (copied from agent-mesh)
│   │   └── mesh-reply.sh      # reply tool for agents (copied from agent-mesh)
│   └── cli/
│       └── index.ts           # NEW: unified CLI wrapper
├── skills/
│   ├── kiro/SKILL.md          # Kiro integration guide
│   ├── claude/SKILL.md        # Claude Code integration guide
│   └── openclaw/SKILL.md      # OpenClaw integration guide
├── docker/
│   ├── Dockerfile             # Updated for new structure
│   └── docker-compose.yml     # Updated for new structure
├── package.json               # With bin entry for "meshterm" CLI
├── tsconfig.json
├── README.md                  # Comprehensive documentation
├── LICENSE                    # MIT
├── install.sh                 # One-command setup
└── .gitignore
```

## What Changed

### From agent-mesh
- `server.ts` → `packages/server/server.ts` (unchanged)
- `mesh-client.ts` → `packages/client/mesh-client.ts` (unchanged)
- `mesh-reply.sh` → `packages/client/mesh-reply.sh` (unchanged)
- `kaze-bridge.ts` → absorbed into `packages/cli/index.ts` (unified CLI)

### New Files
- `packages/cli/index.ts` - Unified CLI with all commands
- `skills/` - Agent integration guides (3 files)
- `README.md` - Full documentation with API reference
- `install.sh` - Interactive setup script
- `LICENSE` - MIT license
- `.gitignore` - Standard ignores

## CLI Commands

All commands from kaze-bridge.ts are now available via `meshterm`:

```bash
meshterm init                    # Configure (server URL, API key, agent name)
meshterm send <to> <message>     # Send message
meshterm poll                    # Check unread messages
meshterm agents                  # List registered agents
meshterm status                  # Show mesh health + stats
meshterm server start            # Start the server
meshterm client start            # Start tmux inject client
```

## Server API

**Unchanged** - all endpoints, auth headers, and JSON formats are identical to agent-mesh/server.ts.

## Next Steps

1. Test the CLI locally
2. Update VPS deployment to use new structure (optional - agent-mesh still works)
3. Phase 2: MCP server implementation
4. Phase 3: Role-based addressing
5. npm publish

## Notes

- agent-mesh/ is untouched (production version still running)
- Server API is 100% backward compatible
- Skills teach agents how to use the mesh
- install.sh generates API keys if not provided

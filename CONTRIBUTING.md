# Contributing to meshterm

Thanks for your interest in contributing!

## Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- [tmux](https://github.com/tmux/tmux) (for testing daemon/client features)

## Setup

```bash
git clone https://github.com/KenEzekiel/meshterm.git
cd meshterm
bun install
```

## Project Structure

```
packages/
├── server/server.ts    # HTTP message broker
├── cli/index.ts        # Unified CLI entry point
├── mcp/index.ts        # MCP server (stdio, for AI agents)
├── client/mesh-client.ts  # tmux inject poller (daemon)
├── agent/index.ts      # Agent lifecycle manager
└── tui/index.ts        # Terminal dashboard
skills/                 # Agent integration guides
docker/                 # Docker deployment files
```

## Running Locally

```bash
# Start the server
MESH_SECRET=dev-secret bun run packages/server/server.ts

# Run the CLI
bun run packages/cli/index.ts --version
bun run packages/cli/index.ts send my-agent "hello"

# Start MCP server (stdio)
bun run packages/cli/index.ts mcp
```

## Making Changes

1. Fork the repo and create a feature branch
2. Make your changes
3. Test manually (no test suite yet — contributions welcome!)
4. Commit with a descriptive message: `feat:`, `fix:`, `docs:`, `chore:`
5. Open a PR against `main`

## Code Style

- TypeScript, Bun runtime
- No external dependencies (use Bun built-ins and standard library)
- Single-file-per-package pattern — keep packages focused
- Match existing code style (no linter configured yet)

## Areas Where Help is Wanted

- **Tests** — server API tests, CLI tests, MCP protocol tests (Bun has a built-in test runner)
- **CI/CD** — GitHub Actions for lint, test, auto-publish on tag
- **WebSocket push** — replace polling for real-time message delivery
- **Per-agent API keys** — currently one shared secret for all agents
- **Standalone binary** — `bun build --compile` for zero-dependency distribution

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

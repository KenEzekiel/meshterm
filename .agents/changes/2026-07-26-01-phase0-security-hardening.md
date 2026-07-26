# Phase 0 security hardening

## Result

The local uncommitted tree now removes the executable skill-message protocol,
treats mesh identities and content as untrusted, requires explicit server
secrets, and uses fail-closed CI.

## Important behavior

- `meshterm poll` only displays and acknowledges message bodies; it does not
  interpret `skill_transfer` or `skill_request`.
- `meshterm skills share/install` exit nonzero.
- Kiro and Claude guidance can be safely refreshed with
  `meshterm setup <provider> --no-daemon`.
- Cursor, Copilot, and Gemini setup installs MCP configuration but will not
  start automatic terminal delivery because Meshterm cannot install their
  provider-specific safety guidance.
- The server rejects missing, blank, and `mesh-dev-secret` credentials.

## Verification

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test` — 17 passed
- `bun run build` — six entrypoints bundled
- CLI version smoke
- missing/default secret startup failures
- explicit-secret health smoke
- Docker Compose validation with and without an explicit secret

No commit, push, PR, deployment, or production mutation was performed.

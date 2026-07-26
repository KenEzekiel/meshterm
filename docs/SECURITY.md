# Security model

## Trust boundary

Possession of a principal credential authenticates exactly one server-managed
principal. Request bodies cannot change that identity. A principal can claim
and acknowledge only its own deliveries.

Message content, attributes, sender display names, and reply references remain
untrusted input to the receiving application. Authentication identifies the
transport principal; it does not authorize shell commands, code changes,
approvals, financial actions, or data access.

## Credentials

- Principal credentials are high-entropy bearer tokens.
- SQLite stores only SHA-256 digests.
- Operator and principal credentials are separate.
- Local client config files are mode 0600.
- Raw credentials are returned once at principal creation.
- Logs and API list responses exclude secrets and digests.

Use TLS for every non-loopback deployment. Restrict the listener with a firewall
or private network and rate-limit it at the reverse proxy.

## Payload handling

Meshterm enforces byte limits but does not parse or execute payloads. It does
not install skills, read local files in response to messages, inject terminal
keystrokes, scrape agent output, or push remote content into Desktop chats.

Consumers must validate their own schemas, apply authorization policy, and ack
only after durable successful processing.

## Removed attack surfaces

V1 removes agent-controlled webhook destinations, skills transfer, rooms and
self-declared moderation grants, TUI terminal rendering, shared-secret sender
claims, task metadata interpretation, outbound product telemetry, and core
terminal process management.

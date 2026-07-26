# Operations

## Runtime

Meshterm is one Bun HTTP process and one SQLite database. The canonical
self-hosted package path is Docker Compose. The existing personal VPS topology
is a supervised bare Bun process; keep exactly one process owner (normally
systemd) and remove any competing manually launched PID before migration.

Required configuration:

- `MESH_OPERATOR_TOKEN`: random operator credential, at least 32 characters.
- `MESH_DATABASE`: SQLite path; default `./meshterm.sqlite`.
- `MESH_HOST`: bind address; default `127.0.0.1`.
- `MESH_PORT`: listen port; default `4200`.

Never put principal or operator credentials in command arguments, logs, message
payloads, committed files, or support output.

## Docker Compose

```bash
export MESH_OPERATOR_TOKEN="$(openssl rand -hex 32)"
docker compose -f docker/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:4200/readyz
```

The database and WAL files live in the `mesh-data` volume. Back up the database
using SQLite's online backup mechanism or after cleanly stopping the process;
do not copy only the main file while WAL writes are active.

## Readiness and metrics

- `GET /livez`: process liveness only.
- `GET /readyz`: SQLite integrity, WAL mode, and schema version.
- `GET /v1/metrics`: authenticated queue depth, oldest queued age, active
  leases, retry count, dead letters, and average acknowledged latency.

Structured logs contain IDs and state transitions only. Payloads and
credentials are intentionally absent.

## Recovery

SQLite commits accepted sends before returning success. After an unclean stop:

1. restart the service against the same database;
2. require `/readyz` to return 200;
3. allow active leases to expire;
4. verify they are reclaimed with the same message and delivery IDs;
5. inspect dead letters and queue age.

Do not delete WAL/SHM files or replace a database while the process is running.

## Credential rotation

Issue a second credential for the same principal, update the client, verify the
new credential can claim the existing mailbox, then revoke only the old
credential ID:

```bash
meshterm admin credential issue agent-name --server https://mesh.example
meshterm admin credential revoke old-credential-id --server https://mesh.example
```

Principal revocation is decommissioning, not rotation. It disables every
credential and makes its mailbox unavailable until an operator applies an
explicit message policy.

Operator credentials are process configuration. Rotate them through the
deployment secret store and restart the service.

## Legacy bare-process migration

The live pre-v1 server uses `MESH_SECRET`, `MESH_STORE`, and a JSON snapshot.
V1 uses `MESH_OPERATOR_TOKEN`, `MESH_DATABASE`, and principal credentials:

1. stop legacy Meshterm daemons, terminal injectors, and every manually launched
   server process;
2. preserve `mesh-store.json` as a read-only timestamped archive;
3. configure one supervised v1 process with a new operator token and SQLite
   path;
4. start it once and require `/readyz` to report WAL and the current schema;
5. provision one principal per agent/service and install its credential;
6. replay only operator-reviewed unacknowledged legacy payloads with explicit
   idempotency keys;
7. keep the legacy JSON archive until the migration is reconciled.

Do not silently infer principals from caller-supplied legacy sender names.

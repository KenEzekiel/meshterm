# CTO Technical and Product Audit — 2026-07-26

> **Remediation status:** The executive verdict and findings below describe the
> pre-v1 baseline. The uncommitted Transport Contract v1 rewrite completed later
> on 2026-07-26 closes the listed Meshterm transport release blockers. It has
> passed automated and local container verification but has not been committed,
> deployed, or exercised through restarted Desktop application UIs.

## Executive verdict

Meshterm is a useful trusted-network messaging prototype, but it is not yet a
safe or reliable foundation for the persistent coding-agent delegation product.

The current architecture is appropriate for personal, cooperative agents:

- one shared bearer secret;
- caller-declared identities;
- in-memory state with JSON snapshots;
- polling and terminal keystroke injection;
- best-effort webhook delivery;
- fire-and-forget messages.

The next product requires a materially stronger contract:

- authenticated and authorized principals;
- durable, ordered, idempotent delivery;
- explicit claim/acknowledgement semantics;
- reliable offline recovery;
- trustworthy approvals and audit history;
- bounded failure behavior;
- one tested operational deployment path.

**Recommendation: no-go for carrying authoritative delegation, approval,
cancellation, or completion events until the P0 items below are closed.**
Feature expansion into more rooms, roles, skills, or UI should pause while the
transport contract is hardened.

## Scope and evidence

This audit reviewed:

- every Meshterm runtime package;
- the server API, persistence, auth, roles, rooms, webhooks, CLI, MCP, terminal
  client, agent lifecycle, packaging, CI, and operations documentation;
- the requirements, design, protocol, orchestrator, worker, supervisor,
  workspace, and Meshterm adapter in
  `persistent-coding-agent-delegation`;
- an isolated local Meshterm server with a temporary store;
- repository verification commands.

No production mutation, repository commit, push, PR, or deployment was
performed.

### Verification snapshot

| Check | Result |
|---|---|
| `bun test` in Meshterm | Failed: no tests found |
| Meshterm configured type check | Failed: `tsc` script does not exist |
| Strict external TypeScript check | Failed with 227 diagnostics |
| CLI load smoke | Passed: `meshterm v0.22.10` |
| Delegation repository type check | Passed |
| Delegation repository tests | Passed outside the loopback network sandbox: 96 tests |
| Isolated Meshterm API repros | Confirmed sender spoofing, fetched-state mutation, unreachable purge, room grant bypass, webhook config loss, and role reply loss |

### Local remediation snapshot

The defensive Phase 0 slice was implemented locally after this audit:

- automatic `skill_transfer` installation and `skill_request` file responses
  were removed, and the explicit `skills share/install` commands now fail
  closed;
- generated and packaged agent guidance treats sender labels and message
  content as untrusted;
- existing Kiro/Claude installations have a documented, tested
  `setup --no-daemon` migration, while providers without installable safety
  guidance are limited to MCP polling;
- the server and Compose configuration reject missing, blank, and the previous
  `mesh-dev-secret` default;
- CI now installs from a lockfile and fails on typecheck, tests, build, CLI
  smoke, or server readiness failures.

Local verification passed with 17 tests, strict TypeScript checking, all six
entrypoint builds, CLI load, explicit-secret server health, and Compose
validation. These changes remain uncommitted and do not resolve the broader
identity, authorization, durability, or delivery-contract blockers below.

### Transport Contract v1 remediation snapshot

The subsequent v1 rewrite reduced Meshterm to a generic durable transport:

| Baseline problem | v1 resolution |
|---|---|
| Shared secret and caller-declared sender | Per-principal revocable credentials; sender is derived server-side; operator APIs use a separate token |
| Lossy JSON arrays and newest-first polling | SQLite WAL with migrations, oldest-first recipient deliveries, transactional claim/lease, explicit ack/nack |
| Crash loss and poison-message loops | Lease-expiry redelivery, bounded backoff, attempt history, inspectable retry/discard dead-letter operations |
| Payload/secret exposure | Opaque bounded payloads, digest-only credentials and lease tokens, structured payload-free logs |
| Weak health and no queue visibility | Side-effect-free liveness, store/schema/WAL readiness, scoped queue/lease/retry/DLQ/latency metrics |
| Unsafe and incoherent product surface | Removed automatic skill/file transfer, terminal injection, TUI, rooms, roles, tasks, telemetry, webhooks, and agent lifecycle from core |
| Desktop ambiguity | Pull-only local MCP packaging for Codex Desktop and Claude Desktop; ChatGPT Desktop local STDIO setup fails with accurate remote-MCP guidance |

The new contract remains at-least-once: duplicate delivery is possible, message
loss is not an accepted transition. Coding-task lifecycle, repository transfer,
approvals, execution, and result semantics remain owned by
`persistent-coding-agent-delegation`.

## Actual architecture

```text
CLI / MCP / daemon / webhook client
            |
            | x-mesh-secret (one shared bearer secret)
            v
     Bun HTTP server
       |-- agents Map
       |-- roles Map
       |-- rooms Map
       |-- messages array
       |-- best-effort webhook tasks
       `-- whole-state JSON snapshot
```

Message flow:

```text
POST /messages
  -> append in memory
  -> synchronously rewrite JSON snapshot
  -> optionally launch webhook delivery

GET /messages/:agent?unread=true
  -> return newest unread window
  -> mutate queued -> fetched

PATCH /messages/:id/read
  -> mark read
  -> rewrite JSON snapshot
```

The persistent delegation product correctly keeps coding-specific task semantics
above Meshterm. Its transport adapter polls unread messages, validates an event
envelope, ingests it into a SQLite ledger, then explicitly marks the transport
message read. The gap is that Meshterm's identity, queue, persistence, and
receipt semantics are weaker than that adapter assumes.

## P0 — release blockers

### P0-1: remote arbitrary file write through skill transfer

`packages/cli/index.ts:406-421` parses every polled message as a possible
`skill_transfer`, then passes attacker-controlled `skill_name` and
`files[].path` through `join()` into `writeFileSync()`. There is no path
containment, signature, request nonce, sender authorization, size limit, or user
approval.

**Trigger:** any mesh participant sends a crafted transfer and the recipient
runs `meshterm poll`.

**Impact:** path traversal can overwrite files writable by the local user and
can become code execution.

**Required action:** disable automatic installation immediately. Reintroduce it
only behind explicit approval, an outstanding nonce-bound request, an
authenticated publisher, strict relative-path validation, realpath containment,
size limits, and atomic writes.

### P0-2: remote local-file exfiltration through skill requests

`packages/cli/index.ts:424-438` accepts an unsolicited `skill_request`, treats
the network-provided `skill_name` as a local directory, reads every non-dot
entry, base64-encodes it, and replies to the claimed sender.

**Impact:** traversing names can export local credentials, configuration,
source, or private data.

**Required action:** remove unsolicited auto-response. Network messages must
reference immutable registered skill IDs, never filesystem paths, and every
transfer must be explicitly authorized.

### P0-3: the shared secret makes actor identity and approvals forgeable

`packages/server/server.ts:295-299` authenticates only one global secret.
`packages/server/server.ts:549-677` trusts caller-provided `from_agent`.
The same credential can poll or mutate another agent's queue and manage agents,
roles, rooms, webhooks, messages, and skills.

The generated steering text compounds this at
`packages/cli/index.ts:889-899` by declaring all mesh messages legitimate tasks
and treating a forgeable `user:*` name as highest priority.

**Impact:** a compromised or merely buggy worker can impersonate the user,
forge approval/completion/cancellation, inject terminal keystrokes, or erase
audit evidence. Matching `from_agent` to an event's `sourceAgent` in the
delegation adapter does not help because the caller controls both.

**Required action:** introduce per-agent principals. The server must derive the
sender from credentials, enforce recipient and administrative scopes, separate
operator APIs, bind task events to the assigned worker/supervisor, and record an
immutable authenticated actor in the audit ledger.

### P0-4: admitted unread work can be silently lost

The server stores messages in one array and one JSON file:

- `packages/server/server.ts:17` caps durable history at 1,000 messages;
- `packages/server/server.ts:270-285` persists only the newest 1,000;
- `packages/server/server.ts:591-594,628-631,663-666` drops older runtime
  messages once the array exceeds 1,500, regardless of read state;
- `packages/server/server.ts:254-267` treats a corrupt or partial snapshot as a
  fresh empty server;
- writes overwrite the live store directly, without transaction, fsync, or
  atomic rename.

**Impact:** unread task, approval, progress, or result events can disappear
after a burst, restart, or partial write while `/health` still returns healthy.

**Required action:** move the broker to SQLite with WAL and schema migrations.
Persist every accepted message transactionally. Retention must be state/TTL
aware and must never evict unacknowledged work. Add integrity checks, backups,
restore drills, and storage-aware readiness.

### P0-5: newest-window polling can permanently starve valid events

`packages/server/server.ts:712-725` returns `.slice(-limit)`, so polling is a
newest-message window rather than an ordered queue. The delegation adapter
correctly leaves malformed and unrelated messages unread at
`persistent-coding-agent-delegation/packages/transport-meshterm/src/index.ts:134-201`.

**Trigger:** enough malformed, unrelated, or newer messages fill the polling
window.

**Impact:** older valid events become unreachable forever. A fast producer can
also starve the missing early sequence while the delegation ledger buffers later
events.

**Required action:** consume oldest-first using a stable cursor and server-side
claim/lease. Add quarantine/dead-letter handling so poison messages cannot
occupy the active queue forever.

## P1 — correctness, security, and operational gaps

### Delivery and state

1. **`fetched` is a side effect, not trustworthy delivery.**
   `GET /messages/:agent` changes `queued` to `fetched`
   (`packages/server/server.ts:689-725`) before processing. `mesh_status` calls
   this endpoint (`packages/mcp/index.ts:361-373`), so observing status changes
   delivery state. Concurrent consumers can still receive the same unread
   message. Webhook success, meanwhile, never sets it fetched.

2. **Fetched state can regress after a crash.** The GET mutation is not
   immediately persisted; only the 30-second timer persists it
   (`packages/server/server.ts:288-289`).

3. **The terminal retry queue can permanently suppress an unread message.**
   `packages/client/mesh-client.ts:73-118` adds the ID to `seenIds` before
   injection. After five failed retries it deletes only the retry entry, leaving
   the ID seen forever. The message remains unread but will not be retried until
   process restart.

4. **No transport idempotency.** Every POST generates and appends a new ID
   (`packages/server/server.ts:291-293,615-625,646-657`). If a response is lost
   after persistence, a client retry creates a duplicate. Event-level
   deduplication above the broker does not prevent duplicate queue pressure,
   webhooks, or multi-worker execution races.

5. **Push delivery is best effort and non-durable.**
   `packages/server/server.ts:136-178` launches webhook work without a durable
   outbox, has no request timeout, and treats every 4xx as terminal. A restart
   loses pending retries.

6. **Client network calls have no timeout.** A hung fetch at
   `packages/client/mesh-client.ts:44-47` leaves `processing=true` and stops the
   receive loop.

### Authorization and input boundaries

7. **Default production credential is public.**
   `packages/server/server.ts:13-15` and `docker/docker-compose.yml:15` default
   to `mesh-dev-secret`. Startup must fail closed when an explicit strong
   credential is absent.

8. **Webhook registration permits SSRF and leaks secrets.**
   Agent registration accepts arbitrary URLs/secrets
   (`packages/server/server.ts:365-378`); delivery follows them without scheme,
   DNS/IP, redirect, timeout, or concurrency policy
   (`packages/server/server.ts:136-178`). `GET /agents` returns complete agent
   objects, including webhook secrets.

9. **Moderated rooms are self-authorizing.**
   `packages/server/server.ts:900-905` trusts `{granted:true}` from the posting
   member. A server-issued one-time grant is required.

10. **Mutation schemas are incomplete.** Agent names, role and room members,
    room patches, message field types, limits, and fan-out counts are not
    consistently validated. Invalid persisted shapes can later crash search,
    routing, or delivery.

11. **No rate limiting or backpressure.** Any authenticated participant can
    create large state, fan out to arbitrary role/room membership, force
    synchronous whole-file rewrites, and launch webhook requests.

### Product flow discrepancies

12. **Agent re-registration deletes delivery configuration.**
    `/agents/register` replaces the full agent record
    (`packages/server/server.ts:365-378`). MCP startup re-registers without
    webhook fields (`packages/mcp/index.ts:603-612`), silently changing delivery
    behavior.

13. **Role-backed room membership is documented but absent.**
    `docs/MESSAGING_DESIGN.md:147-168` promises role membership and room
    webhooks. The server checks literal names and fans out to literal entries at
    `packages/server/server.ts:896-944`; it does not fire room webhooks.

14. **Purge is unreachable.** Generic `DELETE /messages/:id` precedes the exact
    purge route (`packages/server/server.ts:465-484`). The isolated repro
    returned 404 `message not found` for `/messages/purge?days=7`.

15. **Role replies lose correlation.** Role constructors omit `reply_to` while
    direct messages preserve it (`packages/server/server.ts:572-653`).

16. **Role edits erase routing priority.**
    `packages/server/server.ts:533-544` resets priority to membership order.

17. **Deletes leave dangling references.** Removing agents or roles does not
    reconcile room membership, role membership, skills, or queued role
    messages.

18. **Agent state disappears on restart.** The derived `agentStatus` map is
    intentionally non-persistent (`packages/server/server.ts:250-252`) and is
    not rebuilt from stored state events.

19. **Agent start can create competing clients.**
    `packages/agent/index.ts:103-158` starts a new mesh client and overwrites the
    saved PID without stopping an existing client for the same agent.

20. **Stop behavior contradicts the README.**
    The README says plain `agent stop` keeps the terminal session
    (`README.md:229-235`), while the agent module defaults `kill-session` to
    true (`packages/agent/index.ts:164-205`).

### Release and operations

21. **CI is false-green.** `.github/workflows/ci.yml:19-28` converts type-check
    and MCP startup failures into success. There are no tests. The server smoke
    checks only unauthenticated health.

22. **The Docker image is broken.** `docker/Dockerfile:3` copies only
    `server.ts`, which imports `../telemetry` at
    `packages/server/server.ts:11`. The image entrypoint cannot resolve the
    module.

23. **Secrets are mishandled locally.**
    `packages/cli/index.ts:39-42` creates config without restrictive mode and
    `packages/cli/index.ts:339-342` prints it. The daemon includes the secret in
    argv at `packages/cli/index.ts:126-132`, contradicting the README's security
    statement.

24. **Runbooks describe incompatible systems.** Project instructions describe
    bare Bun and nonexistent `packages/server/index.ts`; operations docs
    describe Docker; source is HTTP polling while project instructions claim
    WebSocket and webhook HMAC. There is no single authoritative deployment,
    restart, or recovery procedure.

25. **Telemetry is under-disclosed and profile opt-out is inconsistent.**
    `packages/telemetry.ts:5-81` sends a persistent installation ID, platform,
    runtime, events, and message counts externally by default. Opt-out reads
    only the default config, not the active profile.

## Delegation-product gaps above the transport

These belong in `persistent-coding-agent-delegation`, not Meshterm, but they
affect whether the combined product is ready.

1. **Phase 2 is not end to end.** `MeshtermTransport` and `WorkerAcceptor` are
   currently library/test components. No long-running worker consumes,
   validates, ingests, accepts, responds, and acknowledges messages. The live
   verifier uses two identities in one process, not an actual Mac-to-VPS worker
   path, while TASK-201 is marked complete.

2. **One global per-task sequence has no distributed allocator.** Supervisor
   cancellation and worker progress can independently emit the same next
   sequence. The ledger's unique `(task, sequence)` rule makes outcome depend on
   arrival order.

3. **A buffered invalid future event can wedge a task.** Drain stops on the
   invalid event but retains its sequence slot. A corrected event at the same
   sequence then collides permanently.

4. **Event payloads are structurally under-validated.** The envelope validates
   JSON-ness, but event-specific completion, approval, progress, and failure
   payload schemas are not enforced despite TASK-101's acceptance criteria.

5. **Worker rejection incorrectly terminalizes the whole task.** An
   incompatible candidate emits `task.failed`; the first rejected candidate can
   kill the dispatch before a compatible worker accepts. Candidate rejection
   must be separate from orchestrator-declared terminal failure.

6. **Readiness is declarative, not observed.** The acceptor compares
   caller-supplied capabilities; it does not verify the agent executable,
   authentication, workspace, Git/apply support, disk, or supervisor process.

Treat TASK-201 and TASK-202 as component-complete, not milestone-complete, until
the real consumer loop and cross-machine failure drills pass.

## Target architecture

```text
Authenticated principal
  -> authorized send/admin API
  -> transactional SQLite message + delivery outbox
  -> oldest-first claim/lease
  -> validate/process
  -> recipient-scoped acknowledgement
  -> retention only after acknowledgement/TTL policy

Delegation orchestrator
  -> authenticated task/event policy
  -> event-specific schemas
  -> deterministic sequencing authority
  -> durable task state and audit
  -> worker supervisor + real readiness checks
```

Meshterm should remain generic. It should own principal identity, routing,
durable message storage, delivery attempts, claims, acknowledgements, and
transport observability. The delegation layer should continue to own task
states, approvals, workspaces, providers, sequencing, and result review.

## Remediation plan

### Phase 0 — contain immediate risk

1. Disable network-triggered skill installation and auto-sharing.
2. Remove the “not prompt injection” trust instruction; treat mesh content as
   untrusted data unless authenticated policy elevates it.
3. Fail server startup without an explicit strong secret and restricted bind
   configuration.
4. Redact webhook secrets and stop printing/passing credentials through argv.
5. Make CI truthful: install/pin TypeScript, fail type-check, add tests, and
   remove `|| true`/`|| echo`.

**Exit gate:** the file-write/exfiltration repros fail safely; a low-scope agent
cannot impersonate `user:*`; CI fails on a deliberate type/test error.

### Phase 1 — rebuild the generic transport contract

1. Replace JSON snapshots with SQLite/WAL and migrations.
2. Add per-agent credentials and server-derived identity with explicit scopes.
3. Add client idempotency keys and unique constraints.
4. Implement oldest-first cursor polling with atomic claim/lease and
   recipient-scoped acknowledgement.
5. Add poison-message quarantine/dead-letter handling.
6. Add state-aware retention, a durable webhook outbox, timeouts, bounded retry,
   rate limits, and backpressure.
7. Make health side-effect free; add storage-aware readiness and delivery
   metrics.

**Exit gate:** crash/restart, lost-response retry, duplicate consumer,
offline-recipient, poison-message, and retention stress tests pass without loss
or duplicate execution.

### Phase 2 — make product primitives coherent

1. Separate stable agent identity/config from ephemeral sessions/presence.
2. Define referential integrity for agent, role, room, and queued-message
   deletion.
3. Either implement role-aware room membership/webhooks or remove the promise.
4. Replace boolean moderated grants with server-issued one-time grants.
5. Align reply correlation, priority edits, stop behavior, telemetry, and docs.

**Exit gate:** every documented role/room/lifecycle flow has a contract test and
one CLI/MCP integration test.

### Phase 3 — complete the delegation slice

1. Choose a deterministic event sequencing authority or per-producer streams.
2. Add event-specific payload schemas and invalid-buffer recovery.
3. Model worker offers/rejections separately from task failure.
4. Perform live readiness probes.
5. Build the real worker consumer loop with ack-after-durable-ingest.
6. Run Mac-to-VPS acceptance, progress, approval, cancellation, failure,
   reconnect, restart, and result-retrieval drills.

**Exit gate:** five real delegated tasks complete with no manual Meshterm
message handling, no lost/duplicate execution, preserved audit evidence, and
safe result retrieval.

### Phase 4 — production operations

1. Select one authoritative deployment model and delete contradictory runbooks.
2. Add reproducible packaging, image/package smoke tests, process supervision,
   backup/restore, migration, rollback, and disaster-recovery procedures.
3. Add service-level objectives for accepted-message durability, delivery
   latency, queue age, dead letters, and worker availability.

## Product decision

Keep Meshterm as the generic transport layer; do not move coding-task semantics
into it. However, “dumb pipe” must not mean unauthenticated, lossy, or
unobservable. The durable broker and principal model are now core product
infrastructure, not optional hardening.

The strongest near-term product path is:

1. secure and harden Meshterm's generic transport;
2. complete one real OpenCode-to-OpenCode delegation worker;
3. dogfood recovery and review flows;
4. only then expand agent providers, rooms, skills, or managed hosting.

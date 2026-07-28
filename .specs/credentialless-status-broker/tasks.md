# Credentialless Status Broker Split — Implementation Tasks

## Summary

- **Total tasks:** 18
- **Estimated effort:** Long, split across separately approved core,
  integration, and deployment phases
- **Dependencies:** Approved specification; Linux peer-identity feasibility;
  selected external adapter repository/runtime; target deployment topology
- **Current authorization:** Phase 0 specification only

No task below is authorized by approval of this file. Each phase has an
explicit approval gate.

## Phase 0: Specification Review

- [ ] **TASK-0.1:** Review product ownership and out-of-scope boundaries.
  - Files: `.specs/credentialless-status-broker/requirements.md`,
    `.specs/credentialless-status-broker/design.md`
  - Acceptance: Meshterm core contains no Hermes, OpenClaw, Docker, Obsidian,
    or home-lab responsibility; the external adapter owns all runtime-specific
    policy.

- [ ] **TASK-0.2:** Approve, revise, or reject the protocol and phased plan.
  - Files: `.specs/credentialless-status-broker/tasks.md`
  - Acceptance: Ken explicitly identifies the next approved phase; silence or
    general approval does not authorize implementation.
  - Depends on: TASK-0.1

## Phase 1: Kernel Identity Feasibility

**Approval gate:** Requires explicit approval before experiments or files are
created outside these specification artifacts.

- [ ] **TASK-1.1:** Select candidate adapter runtime(s) with Unix peer-credential
  support.
  - Files: External adapter decision record, location TBD
  - Acceptance: Candidate exposes kernel-authenticated UID/GID before request
    processing and does not rely on request content.

- [ ] **TASK-1.2:** Build an isolated `SO_PEERCRED` proof.
  - Files: External adapter test fixture, location TBD
  - Acceptance: Allowed UID, unauthorized UID, forged JSON identity, and
    connection failure cases are demonstrated on Linux.
  - Depends on: TASK-1.1

- [ ] **TASK-1.3:** Validate target container/user-namespace identity semantics.
  - Files: External adapter test fixture and decision record, location TBD
  - Acceptance: Observed UID/GID and group policy are unambiguous on the
    intended topology; otherwise implementation stops for redesign.
  - Depends on: TASK-1.2

## Phase 2: Meshterm Core Contract

**Approval gate:** Requires explicit approval for the exact Meshterm files.
This phase must remain independently usable by any conforming adapter.

- [ ] **TASK-2.1:** Add closed broker protocol types and constants.
  - Files: `packages/client/broker.ts`
  - Acceptance: v1 request, success, error, byte bounds, identifier grammar, and
    operation allowlist are represented without integration-specific imports.

- [ ] **TASK-2.2:** Add strict request and response validation.
  - Files: `packages/client/broker.ts`
  - Acceptance: Unknown/duplicate fields, wrong versions, invalid identifiers,
    malformed metrics, and values outside bounds fail closed.
  - Depends on: TASK-2.1

- [ ] **TASK-2.3:** Add the bounded local broker client.
  - Files: `packages/client/broker.ts`
  - Acceptance: One request/response per connection, deadline, byte caps,
    request-ID matching, close behavior, and redacted failures are tested.
  - Depends on: TASK-2.2

- [ ] **TASK-2.4:** Add explicit credentialless CLI broker mode for `status`.
  - Files: `packages/cli/index.ts`
  - Acceptance: Broker mode never loads a profile or falls back to direct mode;
    direct status remains unchanged when broker mode is absent.
  - Depends on: TASK-2.3

- [ ] **TASK-2.5:** Add core contract and CLI security tests.
  - Files: `packages/client/broker.test.ts`,
    `packages/cli/security.test.ts`
  - Acceptance: Valid flow and malformed, oversized, slow, mismatched,
    unavailable, and secret-leak cases pass.
  - Depends on: TASK-2.3, TASK-2.4

- [ ] **TASK-2.6:** Document the host-neutral protocol and boundary.
  - Files: `docs/STATUS_BROKER.md`, `README.md`
  - Acceptance: Documentation describes any conforming adapter, principal-scoped
    metrics, limits, and explicit exclusions without home-lab/runtime coupling.
  - Depends on: TASK-2.5

## Phase 3: External Integration Adapter

**Approval gate:** Requires explicit approval of the external repository,
runtime, files, and profile access. This phase does not belong in Meshterm core.

- [ ] **TASK-3.1:** Implement peer authorization and closed request parsing.
  - Files: External adapter source/tests, location TBD
  - Acceptance: Kernel UID/GID is checked before profile reads or network calls;
    only v1 `status` is accepted.
  - Depends on: TASK-1.3, TASK-2.2

- [ ] **TASK-3.2:** Implement fixed readiness and metrics retrieval.
  - Files: External adapter source/tests, location TBD
  - Acceptance: Only fixed-origin GET `/readyz` and GET `/v1/metrics` can be
    issued; the existing runtime profile is read in place.
  - Depends on: TASK-3.1

- [ ] **TASK-3.3:** Implement response validation, filtering, and bounds.
  - Files: External adapter source/tests, location TBD
  - Acceptance: Output is reconstructed from the allowlist; partial, malformed,
    oversized, negative, non-finite, or unauthorized upstream results fail
    closed.
  - Depends on: TASK-3.2

- [ ] **TASK-3.4:** Implement redacted audit and resource controls.
  - Files: External adapter source/tests, location TBD
  - Acceptance: Audit allowlist, sink-failure policy, connection limits,
    deadlines, and secret/payload absence tests pass.
  - Depends on: TASK-3.3

## Phase 4: Packaging and Review

**Approval gate:** Packaging remains external to Meshterm core and requires
explicit approval.

- [ ] **TASK-4.1:** Add dedicated socket-directory and service/sidecar packaging.
  - Files: External deployment package, location TBD
  - Acceptance: Only the socket directory crosses the runtime boundary; profile
    and data directories are not mounted or made host-readable.
  - Depends on: TASK-3.4

- [ ] **TASK-4.2:** Run local end-to-end and adversarial integration tests.
  - Files: External integration tests, location TBD
  - Acceptance: Native CLI, adapter, fake Meshterm, peer denial, namespace,
    restart, stale socket, audit, limits, and rollback simulations pass.
  - Depends on: TASK-4.1

- [ ] **TASK-4.3:** Complete independent boundary, code, and security reviews.
  - Files: Review reports only; locations selected during implementation
  - Acceptance: No unresolved release blocker; reviewers confirm there is no
    generic proxy or credential exposure.
  - Depends on: TASK-2.6, TASK-4.2

## Phase 5: Home-Lab Deployment and Cutover

**Approval gate:** Requires a separate, target-specific deployment approval.
It must not be inferred from implementation approval.

- [ ] **TASK-5.1:** Capture pre-deployment state and verify rollback inputs.
  - Files: Deployment record outside Meshterm core
  - Acceptance: Current CLI/runtime/service/profile metadata and recovery steps
    are recorded without secrets.
  - Depends on: TASK-4.3

- [ ] **TASK-5.2:** Deploy adapter and socket exposure without enabling clients.
  - Files: Remote deployment state
  - Acceptance: Ownership, mode, peer authorization, audit, fixed endpoint
    access, and no host profile access are verified.
  - Depends on: TASK-5.1

- [ ] **TASK-5.3:** Cut over host `status` and verify or roll back.
  - Files: Host CLI configuration and deployment record
  - Acceptance: Credentialless status works, metrics are labeled
    principal-scoped, logs are clean, and existing runtime behavior remains
    healthy; any failed gate triggers rollback.
  - Depends on: TASK-5.2

## Phase 6: Credential Rotation Drill

**Approval gate:** Requires separate future approval after stable cutover.

- [ ] **TASK-6.1:** Plan and execute a credential-rotation drill independently.
  - Files: Separate rotation plan and deployment record
  - Acceptance: New credential is verified in the protected runtime, old
    credential is revoked only after success, no credential becomes
    host-readable, and rollback is documented.
  - Depends on: Stable completion of TASK-5.3 and explicit rotation approval

## Verification Gates

### Gate A: Specification

- Exactly three files exist in
  `.specs/credentialless-status-broker/`.
- Requirements use EARS-style `WHEN ... THE SYSTEM SHALL ...` statements.
- Ownership, threats, alternatives, sequence, migration, rollback, tests, and
  separate approvals are explicit.
- No implementation or external state change exists.

### Gate B: Meshterm core implementation

Run from the Meshterm repository after dependencies are installed under a
separately approved implementation:

```bash
bun run typecheck
bun test
bun run build
```

Additionally prove:

- broker mode performs zero credential-profile reads;
- direct mode regression tests pass;
- hostile broker contract tests pass;
- upstream code/docs contain no integration-specific names or dependencies.

### Gate C: External adapter implementation

- Kernel peer-identity feasibility and namespace matrix pass.
- Unauthorized and malformed requests cause zero profile and network access.
- Endpoint and response allowlists are complete.
- Secret/payload scanning of output, logs, audit, and process arguments is clean.
- Resource-bound and fault-injection tests pass.

### Gate D: Deployment

- Reviewed socket owner/group/mode and dedicated bind mount match the approved
  plan.
- Host cannot read, traverse to, or receive a copy of the runtime profile.
- Native credentialless status passes through the real socket and TLS path.
- Existing runtime behavior remains healthy.
- Audit and service logs contain no credential, payload, authorization header,
  lease token, profile content, or raw upstream response.

### Gate E: Rollback

- Host broker mode is disabled.
- Socket exposure and adapter are removed.
- Runtime profile is byte-for-byte unchanged.
- Existing runtime Meshterm behavior still works.
- No credential issuance, revocation, or rotation occurred.

## Rollback Boundary

Rollback removes only:

- host broker configuration;
- host access to the dedicated socket;
- the external adapter process/service/sidecar;
- the dedicated runtime socket directory or bind mount.

Rollback must not modify Meshterm server state, rotate or revoke credentials,
change the runtime-owned profile, expose runtime data directories, or revive
legacy Meshterm agents/TUI behavior.

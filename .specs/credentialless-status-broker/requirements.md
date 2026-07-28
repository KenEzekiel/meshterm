# Credentialless Status Broker Split

## Overview

Meshterm will define a host-neutral contract that lets its native CLI request a
bounded `status` view without reading a Meshterm principal credential. The
credential-bearing broker and every Hermes or home-lab runtime concern remain
in a separately owned adapter outside the Meshterm core repository.

This specification covers design and planning only. It does not approve
implementation, deployment, credential access, or credential rotation.

## Product Boundary

### Meshterm core owns

- A versioned, host-neutral local broker protocol for exactly one operation:
  `status`.
- A credentialless CLI client mode that connects to an explicitly configured
  local broker endpoint.
- Strict request, response, error, size, and timeout contracts.
- Protocol types, validation, contract tests, and generic documentation.
- Fail-closed behavior when the broker is unavailable or violates the contract.

### The external integration adapter owns

- Access to an existing runtime-owned Meshterm profile and credential.
- Kernel-authenticated peer identity enforcement using `SO_PEERCRED` or an
  equivalently strong operating-system primitive.
- UID/GID allowlists, socket ownership, group membership, and filesystem modes.
- The allowlist of upstream Meshterm endpoints and response filtering.
- Payload- and secret-free audit logging.
- Hermes, home-lab, Docker, sidecar, service, bind-mount, and container policy.
- Installation, deployment, rollback, and credential-rotation procedures.

The upstream Meshterm implementation must not name or depend on Hermes,
OpenClaw, Docker, Obsidian, Ken's home lab, a particular Linux distribution, or
a particular container layout.

## User Stories

### US-1: Credentialless host status

**As a** host operator
**I want** the native Meshterm CLI to obtain a bounded status result through a
local broker
**So that** the host does not need read access to a principal credential

**Acceptance Criteria:**

- GIVEN broker mode is explicitly configured WHEN `meshterm status` runs THEN
  the CLI sends a versioned `status` request without loading a principal
  credential.
- GIVEN the broker returns a valid bounded response WHEN the CLI receives it
  THEN the CLI prints only the contract-defined status fields.
- GIVEN broker mode is configured WHEN no credential profile exists on the host
  THEN `meshterm status` can still succeed.

### US-2: Runtime-owned credential custody

**As a** runtime owner
**I want** the broker adapter to use the runtime's existing profile in place
**So that** the credential is not copied, moved, linked, or exposed to the host

**Acceptance Criteria:**

- GIVEN the adapter starts WHEN it loads credentials THEN it reads only the
  runtime-owned profile from inside the runtime's protected boundary.
- GIVEN a host user can invoke the CLI WHEN inspecting host-visible paths THEN
  no credential, copied profile, symlink, or expanded profile ACL is present.
- GIVEN the adapter is removed WHEN rollback completes THEN the original
  runtime profile remains unchanged.

### US-3: Least-capability status broker

**As a** security reviewer
**I want** the adapter to expose exactly `status`
**So that** access to a principal-wide credential does not become a general
Meshterm proxy

**Acceptance Criteria:**

- GIVEN any operation other than `status` WHEN the adapter parses the request
  THEN it rejects the request before any network access.
- GIVEN a valid `status` request WHEN the adapter calls Meshterm THEN it calls
  only `GET /readyz` and `GET /v1/metrics`.
- GIVEN a caller supplies a URL, method, path, header, body, credential, or
  passthrough argument WHEN validation runs THEN the adapter rejects it.

### US-4: Authenticated local caller

**As a** runtime owner
**I want** local callers authorized by kernel-provided identity
**So that** socket possession alone or caller-controlled JSON cannot grant
access

**Acceptance Criteria:**

- GIVEN a new connection WHEN the adapter accepts it THEN it obtains peer
  identity from `SO_PEERCRED` or an equivalently strong kernel primitive.
- GIVEN the kernel peer UID/GID is not authorized WHEN a request arrives THEN
  the adapter rejects it before profile access and network access.
- GIVEN a request claims an allowed UID/GID in its content WHEN the kernel peer
  is unauthorized THEN the adapter ignores the claim and rejects the request.

### US-5: Safe observability

**As a** home-lab operator
**I want** bounded status and audit output
**So that** failures can be diagnosed without exposing credentials or message
content

**Acceptance Criteria:**

- GIVEN a completed or rejected request WHEN the adapter writes an audit event
  THEN the event contains only timestamp, request identifier, peer identity,
  operation, outcome, duration, and a bounded reason code.
- GIVEN any upstream response or exception WHEN logging occurs THEN logs contain
  no credential, authorization header, profile content, payload, message body,
  lease token, or raw upstream response.
- GIVEN an upstream error WHEN the adapter responds THEN it returns a stable,
  bounded error code rather than the raw upstream body.

## System Requirements

### REQ-1: Explicit broker selection

WHEN a caller selects broker mode, THE MESHTERM CLI SHALL use only the configured
local broker endpoint and SHALL NOT fall back to loading a credential profile.

### REQ-2: Existing direct mode

WHEN broker mode is not selected, THE MESHTERM CLI SHALL preserve the existing
credential-backed `status` behavior unless a separately approved change says
otherwise.

### REQ-3: One operation

WHEN the upstream broker protocol receives a request, THE PROTOCOL SHALL permit
only the literal operation `status`.

### REQ-4: Versioning

WHEN a request or response is exchanged, THE PROTOCOL SHALL include an explicit
version and SHALL reject unsupported versions without downgrade.

### REQ-5: Closed schemas

WHEN request or response validation runs, THE VALIDATOR SHALL reject missing
required fields, unknown fields, invalid types, duplicate requests, and data
outside defined bounds.

### REQ-6: Fixed upstream authority

WHEN the external adapter handles `status`, THE ADAPTER SHALL use a
deployment-owned Meshterm origin and runtime-owned profile that cannot be
overridden by the caller.

### REQ-7: Endpoint allowlist

WHEN the adapter performs network access, THE ADAPTER SHALL issue only GET
requests to the fixed `/readyz` and `/v1/metrics` paths.

### REQ-8: Reject before effects

WHEN peer authorization, framing, version, operation, or schema validation
fails, THE ADAPTER SHALL reject the request before reading the profile or
performing network access.

### REQ-9: Kernel peer identity feasibility gate

WHEN implementation planning begins, THE IMPLEMENTERS SHALL prove in an
isolated Linux test that the chosen server runtime obtains peer UID/GID from
`SO_PEERCRED` or an equivalent kernel primitive; IF that proof fails, THEN
implementation SHALL stop and the runtime choice SHALL be revised.

### REQ-10: Socket access policy

WHEN the external adapter creates its socket, THE ADAPTER SHALL place it in a
dedicated runtime directory with deployment-defined owner, group, and
least-privilege mode, separate from runtime data and credential directories.

### REQ-11: Resource bounds

WHEN processing a connection, THE ADAPTER SHALL enforce bounded request bytes,
response bytes, read time, upstream time, total time, concurrent connections,
and requests per connection.

### REQ-12: Response filtering

WHEN upstream readiness and metrics succeed, THE ADAPTER SHALL construct a new
response from an explicit field allowlist and SHALL NOT forward either upstream
document verbatim.

### REQ-13: Metrics semantics

WHEN the adapter returns metrics, THE DOCUMENTATION SHALL state that
`/v1/metrics` is scoped to the authenticated principal's recipient mailbox and
does not represent global server metrics.

### REQ-14: Fail-closed behavior

WHEN peer authentication, parsing, profile loading, TLS, timeout, readiness,
upstream authentication, response validation, filtering, or output bounds fail,
THE ADAPTER SHALL return a bounded failure and SHALL NOT return partial status.

### REQ-15: Secret handling

WHEN the adapter reads a credential, THE ADAPTER SHALL keep it in process memory
only as required for the two allowed requests and SHALL NOT place it in
arguments, environment forwarded to child processes, output, audit events, or
host-visible files.

### REQ-16: Audit contract

WHEN any request reaches an authorization decision, THE ADAPTER SHALL record one
bounded structured audit event without payloads, secrets, raw request bodies, or
raw upstream bodies.

### REQ-17: No generic proxy

WHEN future operations are proposed, THE SYSTEM SHALL require a new reviewed
protocol version and explicit product-boundary approval rather than supporting
arbitrary paths, methods, headers, bodies, commands, or passthrough.

### REQ-18: Separate approval gates

WHEN the specification is approved, THE PROJECT SHALL treat core implementation,
adapter implementation, deployment, cutover, and credential rotation as
separate approval gates.

### REQ-19: Rollback safety

WHEN the integration is rolled back, THE OPERATOR SHALL be able to remove the
host broker configuration, socket exposure, and adapter process without
changing or revoking the runtime-owned credential.

### REQ-20: Generic upstream packaging

WHEN Meshterm artifacts are built or documented, THE UPSTREAM ARTIFACTS SHALL
remain usable by any conforming broker implementation without importing or
depending on an integration-specific package.

## Threat Model

### Protected assets

- Runtime-owned principal credential and profile.
- Principal-scoped mailbox metrics.
- Meshterm server origin and TLS trust.
- Runtime boundary, socket endpoint, and audit integrity.
- Availability of the runtime and Meshterm service.

### Adversaries and failure sources

- An unauthorized local user or compromised host process.
- An authorized group member attempting unsupported operations.
- A malicious client sending oversized, malformed, slow, replayed, or
  caller-identity-bearing requests.
- A compromised or misconfigured broker attempting to become a generic proxy.
- A malicious or faulty upstream returning oversized, malformed, or sensitive
  data.
- Configuration drift that exposes the socket or runtime profile.
- Logs, crash output, process arguments, or diagnostics leaking secrets.

### Required controls

- Filesystem DAC plus kernel peer identity authorization.
- Closed, versioned, single-operation protocol.
- Reject-before-profile and reject-before-network ordering.
- Fixed origin and endpoint allowlist.
- Response reconstruction from an allowlist.
- Strict byte, time, and concurrency limits.
- Stable redacted errors and payload-free audit events.
- Negative and fault-injection tests at both contract and integration layers.

### Residual risks

- Any authorized broker caller can observe the permitted Kage-scoped status.
- A fully compromised runtime can read its own credential and bypass the broker.
- A root-level host compromise can bypass ordinary Unix ownership boundaries.
- The adapter narrows capability by policy; Transport v1 credentials themselves
  remain principal-wide.

These residual risks must be documented in deployment review and are not solved
by introducing another principal or copying the existing profile.

## Edge Cases and Error Handling

- Broker socket missing, stale, wrong type, wrong owner, or wrong mode.
- Peer disconnects before completing a frame.
- Multiple frames or trailing bytes are received on a one-request connection.
- Unsupported protocol version or unknown field is received.
- Kernel peer identity cannot be obtained.
- Runtime profile is absent, malformed, unreadable, or unexpectedly
  host-readable.
- Meshterm origin is non-HTTPS outside an explicitly test-only loopback case.
- Readiness returns non-200, invalid JSON, schema mismatch, or `ok: false`.
- Metrics returns 401/403, invalid JSON, unknown values, negative values, or an
  oversized body.
- One upstream request succeeds and the other fails; the result is a complete
  failure, not partial status.
- Audit sink is unavailable. The deployment policy must choose and test whether
  this is a startup failure or per-request failure; silent audit loss is not
  allowed.

## Out of Scope

- A generic HTTP, RPC, shell-command, or Meshterm-command proxy.
- Send, claim, ack, nack, history, message, dead-letter, principal, channel, or
  operator actions.
- Changes to Transport v1 server authentication or credential scopes.
- Creation of a second Kage credential or a status principal.
- Copying, moving, symlinking, exporting, or broadening ACL access to the Kage
  profile.
- Hermes, OpenClaw, Docker, Obsidian, or home-lab logic in Meshterm core.
- A legacy agent, daemon, TUI, terminal injector, screen scraper, or webhook.
- Deployment, cutover, remote host mutation, credential issuance, revocation,
  or rotation under this specification approval.

## Approval Gates

1. **Phase 0 — Specification:** approval covers only these planning artifacts.
2. **Core implementation:** requires separate approval for Meshterm source,
   tests, and generic docs.
3. **Adapter implementation:** requires separate approval in the chosen external
   integration package.
4. **Deployment and cutover:** requires separate approval after implementation
   and security review pass.
5. **Credential rotation drill:** requires separate approval and must not be
   bundled with deployment.

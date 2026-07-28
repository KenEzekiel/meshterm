---
problem: Expose principal-scoped Meshterm status to a host without exposing the runtime-owned principal credential
solved: 2026-07-28
domain: local credential brokering
---

## Problem

The native host CLI needed Transport v1 status, but the only suitable principal
credential belonged inside a protected runtime. Copying the profile, expanding
its ACL, creating another principal-wide credential, or exposing a generic
proxy would all weaken the trust boundary.

## Key Insight

Keep the reusable client contract in Meshterm core and make the
credential-bearing component a closed, status-only integration adapter.
Filesystem socket permissions control who can connect, while Linux
`SO_PEERCRED` supplies the identity used for authorization; request JSON never
supplies identity or upstream authority.

## Approach

1. Define one versioned request and one bounded response for `status`.
2. Make CLI broker selection explicit and prohibit credential-profile fallback.
3. Authenticate the adapter peer before parsing, profile reads, or networking.
4. Fix the HTTPS origin and allow only GET `/readyz` and GET `/v1/metrics`.
5. Reject redirects and require the final URL to equal the requested URL.
6. Reconstruct output from an exact allowlist instead of forwarding upstream
   JSON.
7. Apply one deadline across local reads and both upstream requests.
8. Emit only bounded audit metadata and fail closed if auditing fails.
9. Test malformed frames, unknown fields, redirects, origin confusion,
   exhausted deadlines, unsupported operations, and secret-free output.
10. Treat real Linux peer identity and namespace behavior as a deployment gate,
    not something that can be inferred from non-Linux tests.

## Gotchas

- `SO_PEERCRED` reports effective UID and primary GID, not supplementary group
  membership. The dedicated socket group and peer GID allowlist are distinct
  controls.
- Default HTTP clients may follow redirects; an authenticated metrics request
  must never leave its fixed origin.
- Giving each read or upstream request the full timeout does not create a total
  deadline and permits slow-client resource exhaustion.
- A server string beginning with `https://` is not necessarily an origin; reject
  user information, paths, queries, fragments, and malformed ports.
- Broker mode with a missing option value must fail instead of silently
  returning to credential-backed direct mode.

## Reusable Pattern

WHEN a less-trusted host needs one observation backed by a more-privileged
runtime credential, DO expose a closed capability protocol through a
kernel-authenticated local boundary, BECAUSE moving the credential or proxying
its full authority defeats least privilege.

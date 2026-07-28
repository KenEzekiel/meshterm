# Hermes home-lab status broker adapter

This deployment-specific adapter is intentionally outside Meshterm core. It
keeps the existing Kage v1 profile inside Hermes, authenticates a host caller
with Linux `SO_PEERCRED`, and exposes only the versioned status-broker contract.

The adapter must run where the existing profile is already readable. Only its
dedicated Unix-socket directory may be bind-mounted to the host. Never mount,
copy, link, print, or broaden access to the profile or runtime data directory.

Required launch arguments:

```text
python3 status_broker.py \
  --socket /run/meshterm-status/status.sock \
  --profile /opt/data/home/.meshterm/profiles/kage.json \
  --allowed-uids HOST_UID \
  --allowed-gids HOST_EFFECTIVE_PRIMARY_GID
```

The deployment must set the socket directory owner/group and mode before
starting the broker. The broker creates the socket with mode `0660`, rejects
unauthorized kernel peer identities before profile or network access, permits
only GET `/readyz` and GET `/v1/metrics`, filters the response, and writes
bounded JSON audit events to stdout without secrets or payloads.

The dedicated socket group controls filesystem access. Linux `SO_PEERCRED`
reports the connecting process's effective UID and primary GID, not its
supplementary socket-group membership. Deployment must therefore authorize the
exact host UID and observed effective primary GID independently of the
dedicated socket group, and verify those values across the target container
namespace before cutover.

Rollback disables the host broker setting, removes the dedicated socket bind
mount, and removes this adapter. It does not touch the existing profile or any
Meshterm credential, principal, server data, or delivery.

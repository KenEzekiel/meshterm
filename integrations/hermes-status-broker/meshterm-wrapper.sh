#!/bin/sh
set -eu

export MESHTERM_BROKER_SOCKET="${MESHTERM_BROKER_SOCKET:-/home/ken/.local/run/meshterm-status/status.sock}"
exec /home/ken/.bun/bin/bun /home/ken/meshterm-status-broker/cli/index.js "$@"

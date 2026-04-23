#!/bin/bash
# Reply to an agent via the mesh
# Usage: mesh-reply.sh <to_agent> <message>
# Reads config from ~/.meshterm/config.json (falls back to env vars)

CONFIG_FILE="$HOME/.meshterm/config.json"

if [ -f "$CONFIG_FILE" ] && command -v jq &> /dev/null; then
  MESH_URL="${MESH_URL:-$(jq -r '.server // empty' "$CONFIG_FILE")}"
  MESH_SECRET="${MESH_SECRET:-$(jq -r '.secret // empty' "$CONFIG_FILE")}"
  MESH_AGENT="${MESH_AGENT:-$(jq -r '.agent // empty' "$CONFIG_FILE")}"
fi

MESH_URL="${MESH_URL:-http://localhost:4200}"
MESH_SECRET="${MESH_SECRET:-}"
MESH_AGENT="${MESH_AGENT:-}"

if [ -z "$MESH_SECRET" ] || [ -z "$MESH_AGENT" ]; then
  echo "Error: No config found. Run 'meshterm init' or set MESH_SECRET and MESH_AGENT env vars." >&2
  exit 1
fi

TO="${1:?Usage: mesh-reply.sh <to_agent> <message>}"
shift
BODY="$*"

if [ -z "$BODY" ]; then
  # Read from stdin if no message arg
  BODY=$(cat)
fi

curl -s -X POST "${MESH_URL}/messages" \
  -H "content-type: application/json" \
  -H "x-mesh-secret: ${MESH_SECRET}" \
  -d "$(jq -n --arg from "$MESH_AGENT" --arg to "$TO" --arg body "$BODY" '{from_agent: $from, to_agent: $to, body: $body}')"

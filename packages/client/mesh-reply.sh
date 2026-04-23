#!/bin/bash
# Reply to an agent via the mesh
# Usage: mesh-reply.sh <to_agent> <message>
# Example: mesh-reply.sh kaze "done, files changed: src/auth.ts"

MESH_URL="${MESH_URL:-http://localhost:4200}"
MESH_SECRET="${MESH_SECRET:-your-secret-here}"
MESH_AGENT="${MESH_AGENT:-kiro-mac}"

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

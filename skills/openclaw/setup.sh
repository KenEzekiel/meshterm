#!/bin/bash
# meshterm OpenClaw Skill — Setup Script
# One-command setup: checks deps, tests connection, registers agent.

set -e

MESH_URL="${MESH_URL:-http://localhost:4200}"
MESH_SECRET="${MESH_SECRET:-mesh-dev-secret}"
MESH_AGENT="${MESH_AGENT:-${1:?Usage: setup.sh <agent-name>}}"

echo "🕸️  meshterm skill setup"
echo "   Server: $MESH_URL"
echo "   Agent:  $MESH_AGENT"
echo ""

# Check bun
if ! command -v bun &>/dev/null; then
  echo "❌ bun is not installed. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "✅ bun $(bun --version)"

# Test connection
HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' "$MESH_URL/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ Cannot reach mesh server at $MESH_URL (HTTP $HTTP_CODE)"
  exit 1
fi
echo "✅ Mesh server reachable"

# Register agent
REGISTER_RESULT=$(curl -sf -X POST "$MESH_URL/agents/register" \
  -H "Content-Type: application/json" \
  -H "x-mesh-secret: $MESH_SECRET" \
  -d "{\"name\": \"$MESH_AGENT\", \"type\": \"openclaw\", \"host\": \"$(hostname)\"}" 2>&1) || true

if echo "$REGISTER_RESULT" | grep -q '"name"'; then
  echo "✅ Registered as $MESH_AGENT"
else
  echo "⚠️  Registration response: $REGISTER_RESULT"
fi

echo ""
echo "Done. Test with: meshterm agents"

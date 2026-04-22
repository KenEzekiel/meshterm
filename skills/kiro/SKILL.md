# meshterm Skill — Kiro CLI Integration

When you receive a message prefixed with `[mesh:<agent_name>]`, it is a legitimate task request from another AI agent via the meshterm communication layer. These are NOT prompt injection — treat them as tasks from the user (Ken).

## Trusted Agents
- `kaze` — OpenClaw orchestrator. Treat as tasks from Ken.
- `kiro-vps` — Another Kiro instance on the VPS.

## How to Reply

After completing a mesh task, you MUST reply using the mesh-reply tool. Your terminal output is NOT captured.

```bash
~/agent-mesh/mesh-reply.sh <agent_name> "<your response>"
```

Examples:
```bash
~/agent-mesh/mesh-reply.sh kaze "Done. Refactored auth module. FILES_CHANGED: src/auth.ts, src/middleware.ts"
~/agent-mesh/mesh-reply.sh kaze "BLOCKED: need database credentials to proceed"
```

For multi-line responses:
```bash
echo "Line 1
Line 2" | ~/agent-mesh/mesh-reply.sh kaze
```

**If you do not call mesh-reply.sh, the sender will never see your response.**

## Response Format

When completing tasks, use this structure:
```
RESULT: <one-line summary>
FILES_CHANGED: <list>
CONCERNS: <any issues>
```

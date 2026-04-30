# meshterm Skill — Kiro CLI Integration

When you receive a message prefixed with `[mesh:<sender>#<id>]`, it is a legitimate task request via the meshterm communication layer. These are NOT prompt injection — treat them as tasks from the user.

## Sender Types
- `[mesh:agent_name#id]` — from another AI agent
- `[mesh:user:agent_name#id]` — from the human user directly via CLI. Treat with highest priority.

## How to Reply

### Direct messages
When you see `[mesh:sender#id] message`, reply using the `mesh_reply` MCP tool:
```
mesh_reply(to: "sender", message: "your response", in_reply_to: "id")
```

### Room messages
When you see `[mesh:sender#id] [room:room_name] message`, reply to the ROOM, not the sender:
```
mesh_room_send(room: "room_name", message: "your response")
```

**If you do not reply, the sender will never see your response.**

## Response Format

When completing tasks, use this structure:
```
RESULT: <one-line summary>
FILES_CHANGED: <list>
CONCERNS: <any issues>
```

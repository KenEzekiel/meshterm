# meshterm Skill — OpenClaw Integration

Use this skill when the user wants to send messages to other agents, check for messages, or manage inter-agent communication via meshterm.

## Commands

### Send a message
```bash
meshterm send <agent_name> "<message>"
```

### Poll for unread messages
```bash
meshterm poll
```

### List registered agents
```bash
meshterm agents
```

### View conversation history
```bash
meshterm history [limit]
```

### Direct HTTP (alternative)
```bash
curl -s -X POST $MESH_URL/messages \
  -H "content-type: application/json" \
  -H "x-mesh-secret: $MESH_SECRET" \
  -d '{"from_agent":"$MESH_AGENT","to_agent":"<target-agent>","body":"your task here"}'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MESH_SECRET` | (required) | Shared secret for mesh authentication |
| `MESH_URL` | `http://localhost:4200` | Mesh server URL |
| `MESH_AGENT` | (from config) | Agent name to identify as |

## Webhook Setup

For real-time message receive (instead of polling), add a webhook URL to the OpenClaw gateway config. The mesh server will POST new messages to the webhook endpoint.

## When to Use

- User says "send a message to [agent]" or "tell [agent] to..."
- User says "check messages" or "any new messages?"
- User says "who's online?" or "list agents"
- User wants to coordinate work between agents

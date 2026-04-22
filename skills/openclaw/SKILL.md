# meshterm Skill — OpenClaw Integration

OpenClaw agents communicate with the mesh via direct HTTP. Use the CLI or curl.

## Send a message
```bash
meshterm send <to_agent> "<message>"
```

## Poll for messages
```bash
meshterm poll
```

## List agents
```bash
meshterm agents
```

## Direct HTTP (alternative)
```bash
curl -s -X POST $MESH_URL/messages \
  -H "content-type: application/json" \
  -H "x-mesh-secret: $MESH_SECRET" \
  -d '{"from_agent":"kaze","to_agent":"kiro-mac","body":"your task here"}'
```

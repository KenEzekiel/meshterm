# Role-Based Routing Test Plan

## What was implemented

### Server (`packages/server/server.ts`)
- Added `Role` interface with name, capabilities, agents, priority, fallback
- Added roles Map to state and persistence
- Added `resolveRole()` helper function
- Modified POST /messages to handle `role:xxx` addressing
- Added broadcast support (send to all agents in role)
- Added queued message delivery when agents come online
- Added POST /roles, GET /roles, GET /roles/:name endpoints

### CLI (`packages/cli/index.ts`)
- Added --broadcast flag to send command
- Added `meshterm roles` command
- Added `meshterm role create <name>` command with flags:
  - --agents (required)
  - --priority (optional, defaults to agents list)
  - --fallback (optional, defaults to "queue")
  - --capabilities (optional)

### MCP Server (`packages/mcp/index.ts`)
- Updated mesh_send/mesh_reply descriptions to document role support
- Added broadcast parameter support
- Added mesh_roles tool to list available roles
- Updated tool handlers to show resolved_to and broadcast results

## Test Scenarios

### 1. Create a role
```bash
meshterm role create coder --agents kiro-mac,kiro-vps --priority kiro-vps,kiro-mac --fallback queue
```

### 2. List roles
```bash
meshterm roles
```

### 3. Send to role (single delivery)
```bash
meshterm send role:coder "review auth module"
# Should resolve to highest priority online agent
```

### 4. Broadcast to role
```bash
meshterm send role:coder --broadcast "system update in 5 minutes"
# Should send to ALL agents in the role
```

### 5. Queue fallback (no agents online)
```bash
# When no agents in role:coder are online
meshterm send role:coder "this should queue"
# Message stored with to_agent="role:coder"
# When an agent comes online and polls, message is delivered
```

### 6. Reject fallback
```bash
meshterm role create urgent --agents kiro-mac --fallback reject
meshterm send role:urgent "urgent task"
# If kiro-mac is offline, returns error instead of queuing
```

### 7. Direct agent addressing (backward compatibility)
```bash
meshterm send kiro-mac "direct message"
# Should work exactly as before
```

## Edge Cases Handled

- ✅ Role doesn't exist → 404 error
- ✅ No agents online + queue fallback → message queued with to_agent="role:xxx"
- ✅ No agents online + reject fallback → error returned
- ✅ Empty role agents list → handled by fallback logic
- ✅ Agent not in priority list but online → picks first online agent
- ✅ Queued messages delivered when agent comes online
- ✅ Broadcast to role with no agents → creates 0 messages (count: 0)

## Backward Compatibility

- ✅ Direct agent addressing unchanged
- ✅ Existing message format unchanged
- ✅ No breaking changes to API
- ✅ Old clients can still send/receive messages normally

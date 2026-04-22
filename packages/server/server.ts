#!/usr/bin/env bun
/**
 * Agent Mesh Server
 * Lightweight message broker for inter-agent communication.
 * Runs on VPS, agents poll for messages.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const PORT = Number(process.env.MESH_PORT ?? 4200);
const SECRET = process.env.MESH_SECRET ?? "mesh-dev-secret";
const STORE_PATH = process.env.MESH_STORE ?? "./mesh-store.json";
const MAX_MESSAGES = 1000; // keep last N messages in memory

// Webhook config: when a message arrives for a specific agent, POST to a webhook
// Format: MESH_WEBHOOKS=agent:url:token,agent2:url2:token2
const WEBHOOKS: Map<string, { url: string; token: string }> = new Map();
if (process.env.MESH_WEBHOOKS) {
  for (const entry of process.env.MESH_WEBHOOKS.split(",")) {
    const [agent, url, token] = entry.split("|");
    if (agent && url && token) {
      WEBHOOKS.set(agent, { url, token });
      console.log(`Webhook registered: ${agent} → ${url}`);
    }
  }
}

async function fireWebhook(agent: string, msg: Message) {
  const hook = WEBHOOKS.get(agent);
  if (!hook) return;
  try {
    await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${hook.token}`,
      },
      body: JSON.stringify({
        text: `[meshterm] Message from ${msg.from_agent}: ${msg.body}`,
        mode: "now",
      }),
    });
  } catch (err: any) {
    console.error(`Webhook failed for ${agent}: ${err.message}`);
  }
}

// --- Types ---

interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read: boolean;
}

interface Agent {
  name: string;
  type: string; // "openclaw" | "kiro" | "claude-code" | etc
  host: string; // "vps" | "macbook" | etc
  last_seen: string;
}

interface Role {
  name: string;
  capabilities: string[];
  agents: string[];
  priority: string[];
  fallback: "queue" | "reject";
}

interface Room {
  name: string;
  members: string[];
  mode: "free-form" | "round-robin" | "reactive" | "moderated";
  moderator?: string;
  created_at: string;
  last_activity: string;
}

interface RoomMessage {
  id: string;
  room: string;
  from_agent: string;
  body: string;
  created_at: string;
}

// --- State ---

let messages: Message[] = [];
let agents: Map<string, Agent> = new Map();
let roles: Map<string, Role> = new Map();
let rooms: Map<string, Room> = new Map();
let roomMessages: RoomMessage[] = [];

// Load from disk
if (existsSync(STORE_PATH)) {
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    messages = data.messages ?? [];
    for (const a of data.agents ?? []) agents.set(a.name, a);
    for (const r of data.roles ?? []) roles.set(r.name, r);
    for (const room of data.rooms ?? []) rooms.set(room.name, room);
    roomMessages = data.roomMessages ?? [];
    console.log(`Loaded ${messages.length} messages, ${agents.size} agents, ${roles.size} roles, ${rooms.size} rooms, ${roomMessages.length} room messages`);
  } catch {
    console.log("Fresh start — no valid store found");
  }
}

function persist() {
  writeFileSync(
    STORE_PATH,
    JSON.stringify(
      { 
        messages: messages.slice(-MAX_MESSAGES), 
        agents: [...agents.values()],
        roles: [...roles.values()],
        rooms: [...rooms.values()],
        roomMessages: roomMessages.slice(-MAX_MESSAGES)
      },
      null,
      2
    )
  );
}

// Persist every 30s
setInterval(persist, 30_000);

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function auth(req: Request): boolean {
  return req.headers.get("x-mesh-secret") === SECRET;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Role resolution helper
function resolveRole(roleName: string): { agent: string; resolved_to?: string } | { error: string } {
  const role = roles.get(roleName);
  if (!role) {
    return { error: `role not found: ${roleName}` };
  }

  // Check for online agents (last_seen < 30s)
  const now = Date.now();
  const onlineAgents = role.agents.filter((agentName) => {
    const agent = agents.get(agentName);
    if (!agent) return false;
    const lastSeen = new Date(agent.last_seen).getTime();
    return now - lastSeen < 30_000;
  });

  // Follow priority order
  for (const agentName of role.priority) {
    if (onlineAgents.includes(agentName)) {
      return { agent: agentName, resolved_to: agentName };
    }
  }

  // No priority match, pick first online
  if (onlineAgents.length > 0) {
    return { agent: onlineAgents[0], resolved_to: onlineAgents[0] };
  }

  // No agents online — apply fallback
  if (role.fallback === "queue") {
    return { agent: `role:${roleName}` }; // Keep as role: for queued delivery
  } else {
    return { error: `no agents online for role: ${roleName}` };
  }
}

// --- Server ---

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Health check — no auth
    if (path === "/health") {
      return json({ ok: true, agents: agents.size, messages: messages.length });
    }

    // Everything else needs auth
    if (!auth(req)) {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Agents ---

    // POST /agents/register { name, type, host }
    if (method === "POST" && path === "/agents/register") {
      const body = await req.json();
      const agent: Agent = {
        name: body.name,
        type: body.type ?? "unknown",
        host: body.host ?? "unknown",
        last_seen: new Date().toISOString(),
      };
      agents.set(agent.name, agent);
      persist();
      return json({ ok: true, agent });
    }

    // GET /agents
    if (method === "GET" && path === "/agents") {
      return json([...agents.values()]);
    }

    // --- Roles ---

    // POST /roles { name, capabilities, agents, priority, fallback }
    if (method === "POST" && path === "/roles") {
      const body = await req.json();
      if (!body.name || !body.agents || !body.fallback) {
        return json({ error: "missing name, agents, or fallback" }, 400);
      }
      if (!["queue", "reject"].includes(body.fallback)) {
        return json({ error: "fallback must be 'queue' or 'reject'" }, 400);
      }
      const role: Role = {
        name: body.name,
        capabilities: body.capabilities ?? [],
        agents: body.agents,
        priority: body.priority ?? body.agents,
        fallback: body.fallback,
      };
      roles.set(role.name, role);
      persist();
      return json({ ok: true, role });
    }

    // GET /roles
    if (method === "GET" && path === "/roles") {
      return json([...roles.values()]);
    }

    // GET /roles/:name
    const roleMatch = path.match(/^\/roles\/([^/]+)$/);
    if (method === "GET" && roleMatch) {
      const name = decodeURIComponent(roleMatch[1]);
      const role = roles.get(name);
      if (!role) return json({ error: "not found" }, 404);
      return json(role);
    }

    // --- Messages ---

    // POST /messages { from_agent, to_agent, body, broadcast? }
    if (method === "POST" && path === "/messages") {
      const body = await req.json();
      if (!body.from_agent || !body.to_agent || !body.body) {
        return json({ error: "missing from_agent, to_agent, or body" }, 400);
      }

      // Handle role-based addressing
      if (body.to_agent.startsWith("role:")) {
        const roleName = body.to_agent.slice(5);
        const role = roles.get(roleName);
        
        if (!role) {
          return json({ error: `role not found: ${roleName}` }, 404);
        }

        // Broadcast mode — send to all agents in role
        if (body.broadcast) {
          const createdMessages: Message[] = [];
          for (const agentName of role.agents) {
            const msg: Message = {
              id: genId(),
              from_agent: body.from_agent,
              to_agent: agentName,
              body: body.body,
              created_at: new Date().toISOString(),
              read: false,
            };
            messages.push(msg);
            fireWebhook(msg.to_agent, msg);
            createdMessages.push(msg);
          }
          
          // Trim old messages
          if (messages.length > MAX_MESSAGES * 1.5) {
            messages = messages.slice(-MAX_MESSAGES);
          }
          
          // Update sender last_seen
          const sender = agents.get(body.from_agent);
          if (sender) sender.last_seen = new Date().toISOString();
          persist();
          
          return json({ 
            ok: true, 
            broadcast: true,
            messages: createdMessages,
            count: createdMessages.length 
          });
        }

        // Single delivery — resolve role to agent
        const resolution = resolveRole(roleName);
        if ("error" in resolution) {
          return json({ error: resolution.error }, 400);
        }

        const msg: Message = {
          id: genId(),
          from_agent: body.from_agent,
          to_agent: resolution.agent,
          body: body.body,
          created_at: new Date().toISOString(),
          read: false,
        };
        messages.push(msg);
        fireWebhook(msg.to_agent, msg);
        
        // Trim old messages
        if (messages.length > MAX_MESSAGES * 1.5) {
          messages = messages.slice(-MAX_MESSAGES);
        }
        
        // Update sender last_seen
        const sender = agents.get(body.from_agent);
        if (sender) sender.last_seen = new Date().toISOString();
        persist();
        
        return json({ 
          ok: true, 
          message: msg,
          resolved_to: resolution.resolved_to 
        });
      }

      // Direct agent addressing (original behavior)
      const msg: Message = {
        id: genId(),
        from_agent: body.from_agent,
        to_agent: body.to_agent,
        body: body.body,
        created_at: new Date().toISOString(),
        read: false,
      };
      messages.push(msg);
      fireWebhook(msg.to_agent, msg);
      // Trim old messages
      if (messages.length > MAX_MESSAGES * 1.5) {
        messages = messages.slice(-MAX_MESSAGES);
      }
      // Update sender last_seen
      const sender = agents.get(body.from_agent);
      if (sender) sender.last_seen = new Date().toISOString();
      persist();
      return json({ ok: true, message: msg });
    }

    // GET /messages/:agent?unread=true&limit=50
    const msgMatch = path.match(/^\/messages\/([^/]+)$/);
    if (method === "GET" && msgMatch) {
      const agent = decodeURIComponent(msgMatch[1]);
      const unreadOnly = url.searchParams.get("unread") === "true";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      
      // Update last_seen
      const a = agents.get(agent);
      if (a) a.last_seen = new Date().toISOString();

      // Check for queued role messages that can now be delivered
      const queuedMessages = messages.filter(m => m.to_agent.startsWith("role:") && !m.read);
      for (const msg of queuedMessages) {
        const roleName = msg.to_agent.slice(5);
        const resolution = resolveRole(roleName);
        
        // If this agent is now the resolved target, update the message
        if ("agent" in resolution && resolution.agent === agent && resolution.resolved_to) {
          msg.to_agent = agent;
        }
      }

      let result = messages.filter((m) => m.to_agent === agent);
      if (unreadOnly) result = result.filter((m) => !m.read);
      result = result.slice(-limit);
      return json(result);
    }

    // PATCH /messages/:id/read
    const readMatch = path.match(/^\/messages\/([^/]+)\/read$/);
    if (method === "PATCH" && readMatch) {
      const id = readMatch[1];
      const msg = messages.find((m) => m.id === id);
      if (!msg) return json({ error: "not found" }, 404);
      msg.read = true;
      return json({ ok: true });
    }

    // GET /messages/:agent/history?limit=50
    const histMatch = path.match(/^\/messages\/([^/]+)\/history$/);
    if (method === "GET" && histMatch) {
      const agent = decodeURIComponent(histMatch[1]);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const result = messages
        .filter((m) => m.from_agent === agent || m.to_agent === agent)
        .slice(-limit);
      return json(result);
    }

    // --- Rooms ---

    // POST /rooms { name, members, mode, moderator? }
    if (method === "POST" && path === "/rooms") {
      const body = await req.json();
      if (!body.name || !body.members || !body.mode) {
        return json({ error: "missing name, members, or mode" }, 400);
      }
      if (!["free-form", "round-robin", "reactive", "moderated"].includes(body.mode)) {
        return json({ error: "mode must be free-form, round-robin, reactive, or moderated" }, 400);
      }
      if (body.mode === "moderated" && !body.moderator) {
        return json({ error: "moderator required for moderated mode" }, 400);
      }
      if (rooms.has(body.name)) {
        return json({ error: "room already exists" }, 400);
      }

      const room: Room = {
        name: body.name,
        members: body.members,
        mode: body.mode,
        moderator: body.moderator,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
      };
      rooms.set(room.name, room);
      persist();
      return json({ ok: true, room });
    }

    // GET /rooms
    if (method === "GET" && path === "/rooms") {
      return json([...rooms.values()]);
    }

    // GET /rooms/:name
    const roomGetMatch = path.match(/^\/rooms\/([^/]+)$/);
    if (method === "GET" && roomGetMatch) {
      const name = decodeURIComponent(roomGetMatch[1]);
      const room = rooms.get(name);
      if (!room) return json({ error: "room not found" }, 404);
      return json(room);
    }

    // DELETE /rooms/:name
    const roomDeleteMatch = path.match(/^\/rooms\/([^/]+)$/);
    if (method === "DELETE" && roomDeleteMatch) {
      const name = decodeURIComponent(roomDeleteMatch[1]);
      if (!rooms.has(name)) {
        return json({ error: "room not found" }, 404);
      }
      rooms.delete(name);
      // Remove room messages
      roomMessages = roomMessages.filter(m => m.room !== name);
      persist();
      return json({ ok: true });
    }

    // POST /rooms/:name/join { agent }
    const roomJoinMatch = path.match(/^\/rooms\/([^/]+)\/join$/);
    if (method === "POST" && roomJoinMatch) {
      const name = decodeURIComponent(roomJoinMatch[1]);
      const room = rooms.get(name);
      if (!room) return json({ error: "room not found" }, 404);
      
      const body = await req.json();
      if (!body.agent) {
        return json({ error: "missing agent" }, 400);
      }
      
      if (room.members.includes(body.agent)) {
        return json({ error: "agent already in room" }, 400);
      }
      
      room.members.push(body.agent);
      room.last_activity = new Date().toISOString();
      persist();
      return json({ ok: true, room });
    }

    // POST /rooms/:name/leave { agent }
    const roomLeaveMatch = path.match(/^\/rooms\/([^/]+)\/leave$/);
    if (method === "POST" && roomLeaveMatch) {
      const name = decodeURIComponent(roomLeaveMatch[1]);
      const room = rooms.get(name);
      if (!room) return json({ error: "room not found" }, 404);
      
      const body = await req.json();
      if (!body.agent) {
        return json({ error: "missing agent" }, 400);
      }
      
      if (!room.members.includes(body.agent)) {
        return json({ error: "agent not in room" }, 400);
      }
      
      room.members = room.members.filter(a => a !== body.agent);
      room.last_activity = new Date().toISOString();
      persist();
      return json({ ok: true, room });
    }

    // POST /rooms/:name/messages { from_agent, body }
    const roomMsgMatch = path.match(/^\/rooms\/([^/]+)\/messages$/);
    if (method === "POST" && roomMsgMatch) {
      const name = decodeURIComponent(roomMsgMatch[1]);
      const room = rooms.get(name);
      if (!room) return json({ error: "room not found" }, 404);
      
      const body = await req.json();
      if (!body.from_agent || !body.body) {
        return json({ error: "missing from_agent or body" }, 400);
      }
      
      if (!room.members.includes(body.from_agent)) {
        return json({ error: "agent not a member of this room" }, 400);
      }
      
      const msg: RoomMessage = {
        id: genId(),
        room: name,
        from_agent: body.from_agent,
        body: body.body,
        created_at: new Date().toISOString(),
      };
      roomMessages.push(msg);
      
      // Also create direct messages to each member so daemons pick them up
      for (const member of room.members) {
        if (member === body.from_agent) continue; // skip sender
        const directMsg: Message = {
          id: genId(),
          from_agent: body.from_agent,
          to_agent: member,
          body: `[room:${name}] ${body.body}`,
          created_at: new Date().toISOString(),
          read: false,
        };
        messages.push(directMsg);
      }
      
      // Trim old room messages
      if (roomMessages.length > MAX_MESSAGES * 1.5) {
        roomMessages = roomMessages.slice(-MAX_MESSAGES);
      }
      
      room.last_activity = new Date().toISOString();
      persist();
      return json({ ok: true, message: msg });
    }

    // GET /rooms/:name/messages?limit=50
    const roomMsgGetMatch = path.match(/^\/rooms\/([^/]+)\/messages$/);
    if (method === "GET" && roomMsgGetMatch) {
      const name = decodeURIComponent(roomMsgGetMatch[1]);
      const room = rooms.get(name);
      if (!room) return json({ error: "room not found" }, 404);
      
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const result = roomMessages
        .filter(m => m.room === name)
        .slice(-limit);
      return json(result);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`🕸️  Agent Mesh running on :${PORT}`);

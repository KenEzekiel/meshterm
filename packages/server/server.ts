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

// --- State ---

let messages: Message[] = [];
let agents: Map<string, Agent> = new Map();
let roles: Map<string, Role> = new Map();

// Load from disk
if (existsSync(STORE_PATH)) {
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    messages = data.messages ?? [];
    for (const a of data.agents ?? []) agents.set(a.name, a);
    for (const r of data.roles ?? []) roles.set(r.name, r);
    console.log(`Loaded ${messages.length} messages, ${agents.size} agents, ${roles.size} roles`);
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
        roles: [...roles.values()]
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

    return json({ error: "not found" }, 404);
  },
});

console.log(`🕸️  Agent Mesh running on :${PORT}`);

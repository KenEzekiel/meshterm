#!/usr/bin/env bun
/**
 * Agent Mesh Server
 * Lightweight message broker for inter-agent communication.
 * Runs on VPS, agents poll for messages.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { timingSafeEqual } from "crypto";
import { track, trackMessage } from "../telemetry";

const PORT = Number(process.env.MESH_PORT ?? 4200);
const SECRET = process.env.MESH_SECRET ?? "mesh-dev-secret";
const STORE_PATH = process.env.MESH_STORE ?? "./mesh-store.json";
const CONFIG_PATH = process.env.MESH_CONFIG ?? "";
const MAX_MESSAGES = 1000; // keep last N messages in memory

// --- Webhook Adapter Pattern ---

interface WebhookConfig {
  url: string;
  token: string;
  format: "raw" | "openclaw" | "slack" | "discord" | "custom";
  template?: string; // for custom format — uses {{from}}, {{to}}, {{body}}, {{timestamp}}
  headers?: Record<string, string>; // extra headers
}

interface ServerConfig {
  webhooks?: Record<string, WebhookConfig>;
}

// Webhook adapters — transform a message into the format each service expects
const webhookAdapters: Record<string, (msg: Message, hook: WebhookConfig) => { headers: Record<string, string>; body: string }> = {
  raw: (msg, hook) => ({
    headers: {
      "Content-Type": "application/json",
      ...(hook.token ? { "Authorization": `Bearer ${hook.token}` } : {}),
      ...hook.headers,
    },
    body: JSON.stringify({
      from_agent: msg.from_agent,
      to_agent: msg.to_agent,
      body: msg.body,
      created_at: msg.created_at,
      id: msg.id,
    }),
  }),
  openclaw: (msg, hook) => ({
    headers: {
      "Content-Type": "application/json",
      ...(hook.token ? { "Authorization": `Bearer ${hook.token}` } : {}),
      ...hook.headers,
    },
    body: JSON.stringify({
      text: `[meshterm] Message from ${msg.from_agent}: ${msg.body}`,
      mode: "now",
    }),
  }),
  slack: (msg, hook) => ({
    headers: {
      "Content-Type": "application/json",
      ...hook.headers,
    },
    body: JSON.stringify({
      text: `*[meshterm]* Message from \`${msg.from_agent}\`:\n${msg.body}`,
    }),
  }),
  discord: (msg, hook) => ({
    headers: {
      "Content-Type": "application/json",
      ...hook.headers,
    },
    body: JSON.stringify({
      content: `**[meshterm]** Message from \`${msg.from_agent}\`:\n${msg.body}`,
    }),
  }),
  custom: (msg, hook) => {
    const template = hook.template ?? "{{body}}";
    const rendered = template
      .replace(/\{\{from\}\}/g, msg.from_agent)
      .replace(/\{\{to\}\}/g, msg.to_agent)
      .replace(/\{\{body\}\}/g, msg.body)
      .replace(/\{\{timestamp\}\}/g, msg.created_at)
      .replace(/\{\{id\}\}/g, msg.id);
    return {
      headers: {
        "Content-Type": "application/json",
        ...(hook.token ? { "Authorization": `Bearer ${hook.token}` } : {}),
        ...hook.headers,
      },
      body: rendered,
    };
  },
};

// Load webhooks from config file and/or env
const WEBHOOKS: Map<string, WebhookConfig> = new Map();

// 1. Load from config file (preferred)
function loadServerConfig(): ServerConfig {
  // Try explicit config path
  if (CONFIG_PATH && existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch { /* fall through */ }
  }
  // Try mesh-config.json in current directory
  if (existsSync("./mesh-config.json")) {
    try {
      return JSON.parse(readFileSync("./mesh-config.json", "utf-8"));
    } catch { /* fall through */ }
  }
  return {};
}

const serverConfig = loadServerConfig();
if (serverConfig.webhooks) {
  for (const [agent, config] of Object.entries(serverConfig.webhooks)) {
    WEBHOOKS.set(agent, { format: "raw", ...config });
    console.log(`Webhook registered: ${agent} → ${config.url} (${config.format ?? "raw"})`);
  }
}

// 2. Load from env (backward compatible, defaults to openclaw format)
if (process.env.MESH_WEBHOOKS) {
  for (const entry of process.env.MESH_WEBHOOKS.split(",")) {
    const [agent, url, token] = entry.split("|");
    if (agent && url && token && !WEBHOOKS.has(agent)) {
      WEBHOOKS.set(agent, { url, token, format: "openclaw" });
      console.log(`Webhook registered (env): ${agent} → ${url} (openclaw)`);
    }
  }
}

async function fireWebhook(agent: string, msg: Message) {
  // 1. Check per-agent delivery config
  const agentObj = agents.get(agent);
  if (agentObj?.delivery_method === "webhook" && agentObj.webhook_url) {
    const payload = JSON.stringify({
      id: msg.id,
      from: msg.from_agent,
      to: msg.to_agent,
      body: msg.body,
      timestamp: msg.created_at,
      in_reply_to: msg.reply_to ?? null,
      metadata: msg.metadata ?? null,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (agentObj.webhook_secret) headers["Authorization"] = `Bearer ${agentObj.webhook_secret}`;
    deliverWithRetry(agentObj.webhook_url, headers, payload, agent, msg.id);
  }

  // 2. Config-file webhooks (existing behavior)
  const hook = WEBHOOKS.get(agent);
  if (!hook) return;
  const adapter = webhookAdapters[hook.format] ?? webhookAdapters.raw;
  const { headers, body } = adapter(msg, hook);
  try {
    await fetch(hook.url, { method: "POST", headers, body });
  } catch (err: any) {
    console.error(`Webhook failed for ${agent}: ${err.message}`);
  }
}

async function deliverWithRetry(url: string, headers: Record<string, string>, body: string, agent: string, msgId: string) {
  const delays = [0, 10_000, 30_000, 60_000]; // immediate, 10s, 30s, 60s
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok || (res.status >= 200 && res.status < 500)) return; // success or client error (don't retry 4xx)
      console.error(`Webhook ${agent} attempt ${attempt + 1}: HTTP ${res.status}`);
    } catch (err: any) {
      console.error(`Webhook ${agent} attempt ${attempt + 1}: ${err.message}`);
    }
  }
  console.error(`Webhook delivery failed for ${agent} msg ${msgId} after ${delays.length} attempts`);
}

// --- Types ---

interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  body: string;
  source?: string; // "room:<name>" if from a room message
  reply_to?: string; // message ID this is replying to
  metadata?: Record<string, any>; // opaque client metadata (max 4KB)
  created_at: string;
  read: boolean;
  state: "queued" | "fetched";
  fetched_at?: string;
}

interface Agent {
  name: string;
  type: string; // "openclaw" | "kiro" | "claude-code" | etc
  host: string; // "vps" | "macbook" | etc
  last_seen: string;
  delivery_method?: "poll" | "webhook";
  webhook_url?: string;
  webhook_secret?: string;
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

interface Skill {
  name: string;
  description: string;
  owner_agent: string;
  files: string[];
  tags: string[];
  announced_at: string;
}

// --- State ---

let messages: Message[] = [];
let agents: Map<string, Agent> = new Map();
let roles: Map<string, Role> = new Map();
let rooms: Map<string, Room> = new Map();
let roomMessages: RoomMessage[] = [];
let skills: Map<string, Skill> = new Map();

// Agent status cache (derived from agent_state messages, not persisted)
interface AgentStatus { state: string; progress: number | null; message: string | null; since: string; taskId?: string; }
const agentStatus: Map<string, AgentStatus> = new Map();

// Load from disk
if (existsSync(STORE_PATH)) {
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    messages = data.messages ?? [];
    for (const a of data.agents ?? []) agents.set(a.name, a);
    for (const r of data.roles ?? []) roles.set(r.name, r);
    for (const room of data.rooms ?? []) rooms.set(room.name, room);
    roomMessages = data.roomMessages ?? [];
    for (const s of data.skills ?? []) skills.set(s.name, s);
    console.log(`Loaded ${messages.length} messages, ${agents.size} agents, ${roles.size} roles, ${rooms.size} rooms, ${roomMessages.length} room messages, ${skills.size} skills`);
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
        roomMessages: roomMessages.slice(-MAX_MESSAGES),
        skills: [...skills.values()],
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
  const provided = req.headers.get("x-mesh-secret") ?? "";
  if (provided.length !== SECRET.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(SECRET));
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

    // POST /agents/register { name, type, host, delivery_method?, webhook_url?, webhook_secret? }
    if (method === "POST" && path === "/agents/register") {
      const body = await req.json();
      const agent: Agent = {
        name: body.name,
        type: body.type ?? "unknown",
        host: body.host ?? "unknown",
        last_seen: new Date().toISOString(),
        ...(body.delivery_method ? { delivery_method: body.delivery_method } : {}),
        ...(body.webhook_url ? { webhook_url: body.webhook_url } : {}),
        ...(body.webhook_secret ? { webhook_secret: body.webhook_secret } : {}),
      };
      agents.set(agent.name, agent);
      persist();
      track("agent_connect");
      return json({ ok: true, agent });
    }

    // GET /agents
    if (method === "GET" && path === "/agents") {
      const now = Date.now();
      const result = [...agents.values()].map(a => {
        const status = agentStatus.get(a.name);
        // Expire: if last_seen > 5min and state is "working", return "unknown"
        if (status && a.last_seen && (now - new Date(a.last_seen).getTime() > 300_000) && status.state === "working") {
          return { ...a, status: { ...status, state: "unknown" } };
        }
        return { ...a, status: status ?? null };
      });
      return json(result);
    }

    // PATCH /agents/:name — update delivery config
    const agentPatchMatch = path.match(/^\/agents\/([^/]+)$/);
    if (method === "PATCH" && agentPatchMatch) {
      const name = decodeURIComponent(agentPatchMatch[1]);
      const agent = agents.get(name);
      if (!agent) return json({ error: "agent not found" }, 404);
      const body = await req.json();
      if (body.delivery_method !== undefined) agent.delivery_method = body.delivery_method;
      if (body.webhook_url !== undefined) agent.webhook_url = body.webhook_url;
      if (body.webhook_secret !== undefined) agent.webhook_secret = body.webhook_secret;
      if (body.type !== undefined) agent.type = body.type;
      if (body.host !== undefined) agent.host = body.host;
      persist();
      return json({ ok: true, agent });
    }

    // POST /agents/heartbeat { name }
    if (method === "POST" && path === "/agents/heartbeat") {
      const body = await req.json();
      if (!body.name) {
        return json({ error: "missing name" }, 400);
      }
      const agent = agents.get(body.name);
      if (agent) {
        agent.last_seen = new Date().toISOString();
      } else {
        // Auto-register on first heartbeat
        agents.set(body.name, {
          name: body.name,
          type: body.type ?? "unknown",
          host: body.host ?? "unknown",
          last_seen: new Date().toISOString(),
        });
      }
      return json({ ok: true });
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
      trackMessage();
      if (!body.from_agent || !body.to_agent || !body.body) {
        return json({ error: "missing from_agent, to_agent, or body" }, 400);
      }
      if (typeof body.body === "string" && body.body.length > 100_000) {
        return json({ error: "message body too large (max 100KB)" }, 413);
      }
      if (body.metadata && JSON.stringify(body.metadata).length > 4096) {
        return json({ error: "metadata too large (max 4KB)" }, 413);
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
              ...(body.metadata ? { metadata: body.metadata } : {}),
              created_at: new Date().toISOString(),
              read: false,
              state: "queued",
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
          ...(body.metadata ? { metadata: body.metadata } : {}),
          created_at: new Date().toISOString(),
          read: false,
          state: "queued",
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
        ...(body.reply_to ? { reply_to: body.reply_to } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        created_at: new Date().toISOString(),
        read: false,
        state: "queued",
      };
      messages.push(msg);
      // Update agent status cache if this is a state message
      if (msg.metadata?.type === "agent_state" && msg.metadata.agent) {
        agentStatus.set(msg.metadata.agent, { state: msg.metadata.state, progress: msg.metadata.progress ?? null, message: msg.metadata.message ?? null, since: msg.metadata.since ?? msg.created_at, taskId: msg.metadata.taskId });
      }
      fireWebhook(msg.to_agent, msg);
      // Trim old messages
      if (messages.length > MAX_MESSAGES * 1.5) {
        messages = messages.slice(-MAX_MESSAGES);
      }
      // Update sender last_seen
      const sender = agents.get(body.from_agent);
      if (sender) sender.last_seen = new Date().toISOString();
      persist();
      const recipient = agents.get(body.to_agent);
      return json({ 
        ok: true, 
        message: msg,
        recipient_exists: !!recipient,
        recipient_last_seen: recipient?.last_seen ?? null,
      });
    }

    // GET /messages/by-id/:id — fetch single message by ID
    const msgByIdMatch = path.match(/^\/messages\/by-id\/([^/]+)$/);
    if (method === "GET" && msgByIdMatch) {
      const id = decodeURIComponent(msgByIdMatch[1]);
      const msg = messages.find(m => m.id === id);
      if (!msg) return json({ error: "not found" }, 404);
      return json(msg);
    }

    // GET /messages/:agent?unread=true&limit=50
    const msgMatch = path.match(/^\/messages\/([^/]+)$/);
    if (method === "GET" && msgMatch && msgMatch[1] !== "search") {
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
      
      // Mark fetched messages
      const now = new Date().toISOString();
      for (const m of result) {
        if (m.state === "queued") {
          m.state = "fetched";
          m.fetched_at = now;
        }
      }
      
      return json(result);
    }

    // PATCH /messages/:id/read
    const readMatch = path.match(/^\/messages\/([^/]+)\/read$/);
    if (method === "PATCH" && readMatch) {
      const id = readMatch[1];
      const msg = messages.find((m) => m.id === id);
      if (!msg) return json({ error: "not found" }, 404);
      msg.read = true;
      persist();
      return json({ ok: true });
    }

    // GET /messages/:id/status
    const statusMatch = path.match(/^\/messages\/([^/]+)\/status$/);
    if (method === "GET" && statusMatch) {
      const id = statusMatch[1];
      const msg = messages.find((m) => m.id === id);
      if (!msg) return json({ error: "not found" }, 404);
      return json({
        id: msg.id,
        state: msg.state ?? "queued",
        read: msg.read,
        created_at: msg.created_at,
        fetched_at: msg.fetched_at ?? null,
        from_agent: msg.from_agent,
        to_agent: msg.to_agent,
      });
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
      
      // Enforce room mode
      if (room.mode === "moderated") {
        // Only moderator can post, or agents explicitly granted turn
        if (body.from_agent !== room.moderator && !body.granted) {
          return json({ error: "moderated room: only the moderator can post, or use {granted: true} when called on" }, 403);
        }
      } else if (room.mode === "round-robin") {
        // Enforce turn order based on members list
        const lastMsg = roomMessages.filter(m => m.room === name).slice(-1)[0];
        if (lastMsg) {
          const lastIdx = room.members.indexOf(lastMsg.from_agent);
          const expectedIdx = (lastIdx + 1) % room.members.length;
          const expectedAgent = room.members[expectedIdx];
          if (body.from_agent !== expectedAgent) {
            return json({ error: `round-robin: it's ${expectedAgent}'s turn` }, 403);
          }
        }
        // First message: anyone can start
      }
      // reactive + free-form: no restrictions
      
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
          source: `room:${name}`,
          created_at: new Date().toISOString(),
          read: false,
          state: "queued",
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

    // --- Skills ---

    // POST /skills — announce a skill
    if (method === "POST" && path === "/skills") {
      const body = await req.json();
      if (!body.name || !body.owner_agent) return json({ error: "name and owner_agent required" }, 400);
      const skill: Skill = {
        name: body.name,
        description: body.description ?? "",
        owner_agent: body.owner_agent,
        files: body.files ?? ["SKILL.md"],
        tags: body.tags ?? [],
        announced_at: new Date().toISOString(),
      };
      skills.set(skill.name, skill);
      persist();
      return json({ ok: true, skill });
    }

    // GET /skills — list/search skills
    if (method === "GET" && path === "/skills") {
      const agent = url.searchParams.get("agent");
      const q = url.searchParams.get("q");
      let result = [...skills.values()];
      if (agent) result = result.filter(s => s.owner_agent === agent);
      if (q) {
        const lower = q.toLowerCase();
        result = result.filter(s => s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower) || s.tags.some(t => t.toLowerCase().includes(lower)));
      }
      return json(result);
    }

    // GET /skills/:name — get skill metadata
    const skillGetMatch = path.match(/^\/skills\/([^/]+)$/);
    if (method === "GET" && skillGetMatch) {
      const name = decodeURIComponent(skillGetMatch[1]);
      const skill = skills.get(name);
      if (!skill) return json({ error: "skill not found" }, 404);
      return json(skill);
    }

    // DELETE /skills/:name — remove from index
    if (method === "DELETE" && skillGetMatch) {
      const name = decodeURIComponent(skillGetMatch[1]);
      if (!skills.has(name)) return json({ error: "skill not found" }, 404);
      skills.delete(name);
      persist();
      return json({ ok: true });
    }

    // --- Search & Tasks ---

    // GET /messages/search?q=<query>&from=<agent>&to=<agent>&since=<duration>&limit=<n>
    if (method === "GET" && path === "/messages/search") {
      const q = url.searchParams.get("q");
      if (!q) return json({ error: "missing q parameter" }, 400);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const since = url.searchParams.get("since");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const qLower = q.toLowerCase();

      let sinceDate: Date | null = null;
      if (since) {
        const match = since.match(/^(\d+)([dhm])$/);
        if (match) {
          const [, n, unit] = match;
          const ms = unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000;
          sinceDate = new Date(Date.now() - Number(n) * ms);
        }
      }

      const results = messages.filter(m => {
        if (from && m.from_agent !== from) return false;
        if (to && m.to_agent !== to) return false;
        if (sinceDate && new Date(m.created_at) < sinceDate) return false;
        return m.body.toLowerCase().includes(qLower);
      }).slice(-limit).map(m => ({
        id: m.id,
        from_agent: m.from_agent,
        to_agent: m.to_agent,
        body: m.body.length > 200 ? m.body.slice(0, 200) + "..." : m.body,
        created_at: m.created_at,
        metadata: m.metadata,
      }));

      return json(results);
    }

    // GET /tasks?since=<duration>
    if (method === "GET" && path === "/tasks") {
      const since = url.searchParams.get("since");
      let sinceDate: Date | null = null;
      if (since) {
        const match = since.match(/^(\d+)([dhm])$/);
        if (match) {
          const [, n, unit] = match;
          const ms = unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000;
          sinceDate = new Date(Date.now() - Number(n) * ms);
        }
      }

      const taskId = url.searchParams.get("taskId");
      if (taskId) {
        // Return all messages for a specific task
        const taskMsgs = messages.filter(m => m.metadata?.taskId === taskId);
        return json(taskMsgs);
      }

      // List distinct tasks
      const tasks = new Map<string, { taskId: string; taskTitle?: string; messages: number; agents: Set<string>; started: string; lastActivity: string; latestPhase?: string }>();
      for (const m of messages) {
        const tid = m.metadata?.taskId;
        if (!tid) continue;
        if (sinceDate && new Date(m.created_at) < sinceDate) continue;
        if (!tasks.has(tid)) tasks.set(tid, { taskId: tid, messages: 0, agents: new Set(), started: m.created_at, lastActivity: m.created_at });
        const t = tasks.get(tid)!;
        t.messages++;
        t.agents.add(m.from_agent);
        if (m.created_at > t.lastActivity) t.lastActivity = m.created_at;
        if (m.metadata?.taskPhase) t.latestPhase = m.metadata.taskPhase;
        if (m.metadata?.taskTitle && !t.taskTitle) t.taskTitle = m.metadata.taskTitle;
      }

      return json([...tasks.values()].map(t => ({ ...t, agents: [...t.agents] })));
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`🕸️  Agent Mesh running on :${PORT}`);
track("server_start");

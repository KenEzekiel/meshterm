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

// --- State ---

let messages: Message[] = [];
let agents: Map<string, Agent> = new Map();

// Load from disk
if (existsSync(STORE_PATH)) {
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    messages = data.messages ?? [];
    for (const a of data.agents ?? []) agents.set(a.name, a);
    console.log(`Loaded ${messages.length} messages, ${agents.size} agents`);
  } catch {
    console.log("Fresh start — no valid store found");
  }
}

function persist() {
  writeFileSync(
    STORE_PATH,
    JSON.stringify(
      { messages: messages.slice(-MAX_MESSAGES), agents: [...agents.values()] },
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

    // --- Messages ---

    // POST /messages { from_agent, to_agent, body }
    if (method === "POST" && path === "/messages") {
      const body = await req.json();
      if (!body.from_agent || !body.to_agent || !body.body) {
        return json({ error: "missing from_agent, to_agent, or body" }, 400);
      }
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

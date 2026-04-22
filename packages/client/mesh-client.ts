#!/usr/bin/env bun
/**
 * Mesh Client v2 — Dumb pipe. Inject only.
 * Polls mesh for messages, injects into tmux. That's it.
 * The agent replies back via mesh-reply.sh (a tool it knows about).
 *
 * Usage:
 *   MESH_SECRET=xxx bun mesh-client.ts --agent kiro-mac --session kiro --mesh https://mesh.kennezekiel.tech
 */

import { parseArgs } from "util";

const { values: args } = parseArgs({
  options: {
    agent: { type: "string", default: "kiro-mac" },
    session: { type: "string", default: "kiro" },
    mesh: { type: "string", default: "https://mesh.kennezekiel.tech" },
    secret: { type: "string", default: process.env.MESH_SECRET ?? "" },
    poll: { type: "string", default: "5000" },
    type: { type: "string", default: "kiro" },
    host: { type: "string", default: "unknown" },
  },
});

const MESH = args.mesh!;
const SECRET = args.secret!;
const AGENT = args.agent!;
const SESSION = args.session!;
const POLL_MS = Number(args.poll);

const headers = {
  "content-type": "application/json",
  "x-mesh-secret": SECRET,
};

async function meshFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${MESH}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error(`Mesh ${res.status}: ${await res.text()}`);
  return res.json();
}

function tmuxSend(session: string, text: string) {
  const escaped = text.replace(/'/g, "'\\''");
  const result = Bun.spawnSync(["tmux", "send-keys", "-t", session, escaped, "Enter"]);
  if (result.exitCode !== 0) {
    console.error(`tmux send-keys failed: ${result.stderr.toString()}`);
    return false;
  }
  return true;
}

// --- Register ---
async function register() {
  try {
    await meshFetch("/agents/register", {
      method: "POST",
      body: JSON.stringify({ name: AGENT, type: args.type, host: args.host }),
    });
    console.log(`Registered as ${AGENT}`);
  } catch (e: any) {
    console.error(`Registration failed: ${e.message}`);
  }
}

// --- Main Loop ---
let processing = false;

async function pollAndInject() {
  if (processing) return;

  try {
    const msgs = await meshFetch(`/messages/${AGENT}?unread=true`);
    if (!msgs.length) return;

    processing = true;

    for (const msg of msgs) {
      console.log(`📨 From ${msg.from_agent}: ${msg.body.slice(0, 80)}...`);

      // Inject into tmux
      const injected = `[mesh:${msg.from_agent}] ${msg.body}`;
      if (!tmuxSend(SESSION, injected)) {
        console.error("Failed to inject, skipping");
        continue;
      }

      // Mark as read
      await meshFetch(`/messages/${msg.id}/read`, { method: "PATCH" });
      console.log(`✅ Injected and marked read`);
    }
  } catch (e: any) {
    console.error(`Poll error: ${e.message}`);
  } finally {
    processing = false;
  }
}

// --- Start ---
console.log(`🕸️  Mesh Client v2 (inject-only) | agent=${AGENT} | session=${SESSION} | mesh=${MESH}`);
console.log(`   Polling every ${POLL_MS}ms`);

await register();
setInterval(pollAndInject, POLL_MS);

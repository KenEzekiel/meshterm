#!/usr/bin/env bun
/**
 * Mesh Client v3 — Dumb pipe with retry.
 * Polls mesh for unread messages, injects into tmux.
 * Does NOT mark messages as read — agent does that via MCP mesh_poll/mesh_reply.
 * Re-injects if message stays unread (up to MAX_ATTEMPTS, 30s apart).
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
const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 30_000; // 30s between re-injects

const headers = {
  "content-type": "application/json",
  "x-mesh-secret": SECRET,
};

// Track injected messages: id → { attempts, lastInjectedAt }
const tracker: Map<string, { attempts: number; lastInjectedAt: number }> = new Map();

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

let processing = false;

async function pollAndInject() {
  if (processing) return;

  try {
    const msgs = await meshFetch(`/messages/${AGENT}?unread=true`);
    if (!msgs.length) {
      // All messages read — clean up tracker
      tracker.clear();
      return;
    }

    processing = true;
    const now = Date.now();

    for (const msg of msgs) {
      const tracked = tracker.get(msg.id);

      if (tracked) {
        // Already injected before — check if we should retry
        if (tracked.attempts >= MAX_ATTEMPTS) {
          // Give up, but message stays unread on server (safety net for mesh_poll)
          continue;
        }
        if (now - tracked.lastInjectedAt < RETRY_INTERVAL_MS) {
          // Too soon to retry
          continue;
        }
        // Re-inject
        const injected = `[mesh:${msg.from_agent}] ${msg.body}`;
        if (tmuxSend(SESSION, injected)) {
          tracked.attempts++;
          tracked.lastInjectedAt = now;
          console.log(`🔄 Re-injected (attempt ${tracked.attempts}/${MAX_ATTEMPTS}): ${msg.body.slice(0, 60)}...`);
        }
      } else {
        // First time seeing this message — inject
        const injected = `[mesh:${msg.from_agent}] ${msg.body}`;
        if (tmuxSend(SESSION, injected)) {
          tracker.set(msg.id, { attempts: 1, lastInjectedAt: now });
          console.log(`📨 Injected from ${msg.from_agent}: ${msg.body.slice(0, 60)}...`);
        } else {
          console.error(`Failed to inject from ${msg.from_agent}, will retry`);
          tracker.set(msg.id, { attempts: 0, lastInjectedAt: 0 }); // retry immediately next cycle
        }
      }
    }

    // Clean up tracker entries for messages that are no longer unread
    const unreadIds = new Set(msgs.map((m: any) => m.id));
    for (const id of tracker.keys()) {
      if (!unreadIds.has(id)) tracker.delete(id);
    }
  } catch (e: any) {
    console.error(`Poll error: ${e.message}`);
  } finally {
    processing = false;
  }
}

// --- Start ---
console.log(`🕸️  Mesh Client v3 (inject + retry) | agent=${AGENT} | session=${SESSION} | mesh=${MESH}`);
console.log(`   Polling every ${POLL_MS}ms | Max ${MAX_ATTEMPTS} inject attempts | Retry every ${RETRY_INTERVAL_MS / 1000}s`);

await register();
setInterval(pollAndInject, POLL_MS);

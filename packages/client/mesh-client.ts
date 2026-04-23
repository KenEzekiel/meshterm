#!/usr/bin/env bun
/**
 * Mesh Client v3.1 — Dumb pipe with retry on failure.
 * Polls mesh for unread messages, injects into tmux.
 * Marks as read after successful first inject.
 * Retries only if tmux inject FAILS (not if agent is busy).
 */

import { parseArgs } from "util";

const { values: args } = parseArgs({
  options: {
    agent: { type: "string", default: "" },
    session: { type: "string", default: "kiro" },
    mesh: { type: "string", default: "http://localhost:4200" },
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
const MAX_RETRY = 5;
const RETRY_INTERVAL_MS = 30_000;

const headers = {
  "content-type": "application/json",
  "x-mesh-secret": SECRET,
};

// Track failed injects for retry: id → { attempts, lastAttemptAt }
const retryQueue: Map<string, { attempts: number; lastAttemptAt: number; msg: any }> = new Map();

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
    // Process new unread messages
    const msgs = await meshFetch(`/messages/${AGENT}?unread=true`);

    processing = true;

    for (const msg of msgs) {
      // Skip if already in retry queue (handled below)
      if (retryQueue.has(msg.id)) continue;

      const injected = `[mesh:${msg.from_agent}] ${msg.body}`;
      if (tmuxSend(SESSION, injected)) {
        // Success — mark as read immediately
        await meshFetch(`/messages/${msg.id}/read`, { method: "PATCH" });
        console.log(`📨 Injected + read: ${msg.from_agent}: ${msg.body.slice(0, 60)}...`);
      } else {
        // Failed to inject — add to retry queue, DON'T mark read
        retryQueue.set(msg.id, { attempts: 1, lastAttemptAt: Date.now(), msg });
        console.error(`❌ Inject failed, queued for retry: ${msg.body.slice(0, 60)}...`);
      }
    }

    // Process retry queue
    const now = Date.now();
    for (const [id, entry] of retryQueue) {
      if (entry.attempts >= MAX_RETRY) {
        console.error(`💀 Gave up after ${MAX_RETRY} attempts: ${entry.msg.body.slice(0, 60)}...`);
        retryQueue.delete(id);
        continue;
      }
      if (now - entry.lastAttemptAt < RETRY_INTERVAL_MS) continue;

      const injected = `[mesh:${entry.msg.from_agent}] ${entry.msg.body}`;
      if (tmuxSend(SESSION, injected)) {
        await meshFetch(`/messages/${id}/read`, { method: "PATCH" });
        console.log(`🔄 Retry success (attempt ${entry.attempts + 1}): ${entry.msg.body.slice(0, 60)}...`);
        retryQueue.delete(id);
      } else {
        entry.attempts++;
        entry.lastAttemptAt = now;
        console.error(`🔄 Retry failed (attempt ${entry.attempts}/${MAX_RETRY})`);
      }
    }
  } catch (e: any) {
    console.error(`Poll error: ${e.message}`);
  } finally {
    processing = false;
  }
}

// --- Start ---
console.log(`🕸️  Mesh Client v3.1 (inject + retry on failure) | agent=${AGENT} | session=${SESSION} | mesh=${MESH}`);
console.log(`   Polling every ${POLL_MS}ms | Max ${MAX_RETRY} retries on inject failure`);

await register();
setInterval(pollAndInject, POLL_MS);

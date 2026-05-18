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
    agent: { type: "string", default: process.env.__MESH_CLIENT_AGENT ?? "" },
    session: { type: "string", default: process.env.__MESH_CLIENT_SESSION ?? "kiro" },
    mesh: { type: "string", default: process.env.__MESH_CLIENT_MESH ?? "http://localhost:4200" },
    secret: { type: "string", default: process.env.__MESH_CLIENT_SECRET ?? process.env.MESH_SECRET ?? "" },
    poll: { type: "string", default: process.env.__MESH_CLIENT_POLL ?? "5000" },
    type: { type: "string", default: process.env.__MESH_CLIENT_TYPE ?? "kiro" },
    host: { type: "string", default: process.env.__MESH_CLIENT_HOST ?? "unknown" },
  },
  strict: false,
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
  const result = Bun.spawnSync(["tmux", "send-keys", "-t", `=${session}`, escaped, "Enter"]);
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

      const injected = `[mesh:${msg.from_agent}#${msg.id}] ${msg.body}`;
      if (tmuxSend(SESSION, injected)) {
        // Success — mark as read immediately
        await meshFetch(`/messages/${msg.id}/read`, { method: "PATCH" });
        lastTaskInjectedAt = Date.now();
        lastOutputChangeAt = Date.now();
        // Immediately report working state
        if (currentState !== "working") {
          currentState = "working";
          currentProgress = null;
          currentMessage = `Processing: ${msg.body.slice(0, 60)}`;
          await notifyStateChange("working", null, currentMessage);
        }
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

      const injected = `[mesh:${entry.msg.from_agent}#${entry.msg.id}] ${entry.msg.body}`;
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

// --- State Detection ---
const STUCK_TIMEOUT_MS = Number(process.env.MESH_CLIENT_STUCK_TIMEOUT ?? 600_000); // 10 min default
const STATE_POLL_MS = 20_000; // check tmux every 20s
const STATE_NOTIFY_TO = process.env.MESH_CLIENT_NOTIFY ?? "kaze";

type AgentState = "idle" | "working" | "stuck" | "done" | "unknown";
let currentState: AgentState = "unknown";
let currentProgress: number | null = null;
let currentMessage: string = "";
let lastOutputHash = "";
let lastTaskInjectedAt = 0;
let lastOutputChangeAt = Date.now();

function tmuxCapture(session: string): string {
  const result = Bun.spawnSync(["tmux", "capture-pane", "-t", session, "-p", "-S", "-30"]);
  if (result.exitCode !== 0) return "";
  return result.stdout.toString();
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function detectProgress(output: string): { progress: number | null; message: string } {
  const lines = output.trim().split("\n").filter(l => l.trim());
  const last10 = lines.slice(-10).join("\n");

  // Try X/Y pattern (e.g., "3/4 files", "15/25 tests")
  const fraction = last10.match(/(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const [, n, total] = fraction;
    const pct = Math.round((Number(n) / Number(total)) * 100) / 100;
    if (pct <= 1 && Number(total) > 1) return { progress: pct, message: fraction[0] };
  }

  // Try X% pattern
  const pct = last10.match(/(\d+)%/);
  if (pct) return { progress: Number(pct[1]) / 100, message: `${pct[1]}%` };

  // Try "step N of M"
  const step = last10.match(/step\s+(\d+)\s+of\s+(\d+)/i);
  if (step) return { progress: Math.round((Number(step[1]) / Number(step[2])) * 100) / 100, message: `Step ${step[1]} of ${step[2]}` };

  // Last meaningful line as message
  const lastLine = lines[lines.length - 1]?.trim().slice(0, 80) || "";
  return { progress: null, message: lastLine };
}

function detectState(output: string): AgentState {
  const lines = output.trim().split("\n").filter(l => l.trim());
  const lastLines = lines.slice(-5).join("\n");
  if (/[>\u276f%$]\s*$/.test(lastLines) || /Human:\s*$/.test(lastLines) || /\d+%\s*!>/.test(lastLines)) return "idle";
  return "working";
}

async function notifyStateChange(state: AgentState, progress: number | null, message: string) {
  const body = `[state] ${AGENT}: ${state}${message ? ` -- ${message}` : ""}`;
  try {
    await meshFetch("/messages", {
      method: "POST",
      body: JSON.stringify({
        from_agent: AGENT,
        to_agent: STATE_NOTIFY_TO,
        body,
        metadata: {
          type: "agent_state",
          agent: AGENT,
          state,
          progress,
          message: message || null,
          since: new Date().toISOString(),
        },
      }),
    });
    console.log(`📡 State -> ${state}${progress != null ? ` (${Math.round(progress * 100)}%)` : ""}`);
  } catch (e: any) {
    console.error(`State notify failed: ${e.message}`);
  }
}

async function checkState() {
  const output = tmuxCapture(SESSION);
  if (!output) return;

  const hash = simpleHash(output);
  const now = Date.now();

  if (hash !== lastOutputHash) {
    lastOutputHash = hash;
    lastOutputChangeAt = now;
  }

  let detected = detectState(output);
  const { progress, message } = detected === "working" ? detectProgress(output) : { progress: null, message: "" };

  // Stuck detection
  if (detected === "working" && lastTaskInjectedAt > 0 && (now - lastOutputChangeAt) > STUCK_TIMEOUT_MS) {
    detected = "stuck";
  }

  // Notify on state change OR significant progress change
  const progressChanged = progress !== null && currentProgress !== null && Math.abs(progress - currentProgress) >= 0.1;
  if (detected !== currentState || progressChanged) {
    currentState = detected;
    currentProgress = progress;
    currentMessage = message;
    await notifyStateChange(detected, progress, message);
  }
}

// --- Start ---
console.log(`🕸️  Mesh Client v3.1 (inject + retry + state detection) | agent=${AGENT} | session=${SESSION} | mesh=${MESH}`);
console.log(`   Polling every ${POLL_MS}ms | Max ${MAX_RETRY} retries | Stuck timeout: ${STUCK_TIMEOUT_MS / 60000}min | Notify: ${STATE_NOTIFY_TO}`);

await register();
setInterval(pollAndInject, POLL_MS);
setInterval(checkState, STATE_POLL_MS);
// Report initial state shortly after startup
setTimeout(checkState, 3000);

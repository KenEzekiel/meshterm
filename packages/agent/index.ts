#!/usr/bin/env bun
/**
 * meshterm agent lifecycle — start, stop, list agents.
 *
 * Usage:
 *   bun meshterm-agent.ts start --name <name> --cli <command> --session <tmux-session> --mesh <url> --secret <secret>
 *   bun meshterm-agent.ts stop --name <name> [--kill-session]
 *   bun meshterm-agent.ts list
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const STATE_DIR = join(homedir(), ".meshterm");
const STATE_FILE = join(STATE_DIR, "agents.json");

interface AgentEntry {
  name: string;
  session: string;
  meshClientPid: number;
  meshUrl: string;
  cli: string;
  startedAt: string;
}

function loadState(): Record<string, AgentEntry> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, AgentEntry>) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(session: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", session]).exitCode === 0;
}

const [subcommand] = process.argv.slice(2);
const rawArgs = process.argv.slice(3);

switch (subcommand) {
  case "start": {
    const { values: opts } = parseArgs({
      args: rawArgs,
      options: {
        name: { type: "string" },
        cli: { type: "string" },
        session: { type: "string" },
        mesh: { type: "string", default: "http://localhost:4200" },
        secret: { type: "string", default: process.env.MESH_SECRET ?? "" },
        type: { type: "string", default: "kiro" },
        host: { type: "string", default: "unknown" },
      },
    });

    if (!opts.name || !opts.cli || !opts.session) {
      console.error("Usage: meshterm-agent.ts start --name <name> --cli <command> --session <session> [--mesh <url>] [--secret <secret>]");
      process.exit(1);
    }

    const { name, cli, session, mesh, secret } = opts as { name: string; cli: string; session: string; mesh: string; secret: string };

    // 1. Create tmux session if not exists
    if (!tmuxSessionExists(session)) {
      console.log(`Creating tmux session: ${session}`);
      spawnSync("tmux", ["new-session", "-d", "-s", session]);
    } else {
      console.log(`Tmux session exists: ${session}`);
    }

    // 2. Send CLI command into tmux
    console.log(`Sending CLI command: ${cli}`);
    spawnSync("tmux", ["send-keys", "-t", session, cli, "Enter"]);

    // 3. Start mesh-client in background
    const meshClientPath = join(import.meta.dir, "../client/mesh-client.ts");
    const proc = Bun.spawn([
      "bun", meshClientPath,
      "--agent", name,
      "--session", session,
      "--mesh", mesh,
      "--secret", secret,
      "--type", opts.type!,
      "--host", opts.host!,
    ], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    // Detach so it survives this process exiting
    proc.unref();

    console.log(`mesh-client started (PID: ${proc.pid})`);

    // 4. Register agent
    try {
      const res = await fetch(`${mesh}/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-secret": secret },
        body: JSON.stringify({ name, type: opts.type, host: opts.host }),
      });
      if (res.ok) console.log(`Registered ${name} with mesh`);
      else console.error(`Registration failed: ${res.status}`);
    } catch (e: any) {
      console.error(`Registration failed: ${e.message}`);
    }

    // 5. Save state
    const state = loadState();
    state[name] = {
      name,
      session,
      meshClientPid: proc.pid,
      meshUrl: mesh,
      cli,
      startedAt: new Date().toISOString(),
    };
    saveState(state);

    console.log(`✅ Agent ${name} started (session: ${session}, mesh-client PID: ${proc.pid})`);
    break;
  }

  case "stop": {
    const { values: opts } = parseArgs({
      args: rawArgs,
      options: {
        name: { type: "string" },
        "kill-session": { type: "boolean", default: false },
      },
    });

    if (!opts.name) {
      console.error("Usage: meshterm-agent.ts stop --name <name> [--kill-session]");
      process.exit(1);
    }

    const state = loadState();
    const entry = state[opts.name];
    if (!entry) {
      console.error(`Agent "${opts.name}" not found in state.`);
      process.exit(1);
    }

    // Kill mesh-client
    if (isAlive(entry.meshClientPid)) {
      try {
        process.kill(entry.meshClientPid, "SIGTERM");
        console.log(`Killed mesh-client (PID: ${entry.meshClientPid})`);
      } catch (e: any) {
        console.error(`Failed to kill PID ${entry.meshClientPid}: ${e.message}`);
      }
    } else {
      console.log(`mesh-client already dead (PID: ${entry.meshClientPid})`);
    }

    // Optionally kill tmux session
    if (opts["kill-session"] && tmuxSessionExists(entry.session)) {
      spawnSync("tmux", ["kill-session", "-t", entry.session]);
      console.log(`Killed tmux session: ${entry.session}`);
    }

    delete state[opts.name];
    saveState(state);
    console.log(`✅ Agent ${opts.name} stopped`);
    break;
  }

  case "list": {
    const state = loadState();
    const names = Object.keys(state);
    if (names.length === 0) {
      console.log("No agents running.");
      break;
    }
    for (const entry of Object.values(state)) {
      const alive = isAlive(entry.meshClientPid);
      const sessionUp = tmuxSessionExists(entry.session);
      const status = alive && sessionUp ? "✅ running" : alive ? "⚠️  no tmux" : sessionUp ? "⚠️  no mesh-client" : "❌ dead";
      console.log(`${entry.name}  session=${entry.session}  pid=${entry.meshClientPid}  ${status}  started=${entry.startedAt}`);
    }
    break;
  }

  default:
    console.log("Usage: meshterm-agent.ts <start|stop|list>");
    console.log("  start  --name <name> --cli <command> --session <session> [--mesh <url>] [--secret <secret>]");
    console.log("  stop   --name <name> [--kill-session]");
    console.log("  list");
}

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

const STATE_DIR = process.env.MESHTERM_CONFIG_DIR ?? join(homedir(), ".meshterm");
const STATE_FILE = join(STATE_DIR, "agents.json");
const PROFILE = process.env.MESHTERM_PROFILE;
const CONFIG_FILE = PROFILE
  ? join(STATE_DIR, "profiles", `${PROFILE}.json`)
  : join(STATE_DIR, "config.json");

// Load meshterm config for defaults
function loadMeshConfig(): { server: string; secret: string; agent: string } | null {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

const meshConfig = loadMeshConfig();

interface AgentEntry {
  name: string;
  session: string;
  meshClientPid: number;
  meshUrl: string;
  cli: string;
  profile: string;
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

// Resolve tmux path (compiled binaries may not have /opt/homebrew/bin in PATH)
const TMUX = (() => {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) return p;
  }
  return "tmux"; // fallback to PATH
})();

function tmuxSessionExists(session: string): boolean {
  const result = spawnSync(TMUX, ["has-session", "-t", session]);
  return result.status === 0;
}

const [subcommand] = process.argv.slice(2);
const rawArgs = process.argv.slice(3);

export async function runAgent(sub?: string, args?: string[]) {
  const cmd = sub ?? subcommand;
  const cmdArgs = args ?? rawArgs;

  switch (cmd) {
  case "start": {
    const { values: opts } = parseArgs({
      args: cmdArgs,
      options: {
        name: { type: "string" },
        cli: { type: "string" },
        session: { type: "string" },
        mesh: { type: "string", default: meshConfig?.server ?? "http://localhost:4200" },
        secret: { type: "string", default: meshConfig?.secret ?? process.env.MESH_SECRET ?? "" },
        type: { type: "string", default: "kiro" },
        host: { type: "string", default: "unknown" },
      },
    });

    if (!opts.name || !opts.cli) {
      console.error("Usage: meshterm agent start --name <name> --cli <command> [--session <session>] [--mesh <url>] [--secret <secret>]");
      process.exit(1);
    }

    const name = opts.name as string;
    const cli = opts.cli as string;
    const session = (opts.session ?? opts.name) as string;
    const mesh = opts.mesh as string;
    const secret = opts.secret as string;

    // 1. Create tmux session if not exists
    if (!tmuxSessionExists(session)) {
      console.log(`Creating tmux session: ${session}`);
      console.log(`Starting CLI: ${cli}`);
      const tmuxArgs = ["new-session", "-d", "-s", session];
      if (PROFILE) tmuxArgs.push("-e", `MESHTERM_PROFILE=${PROFILE}`);
      tmuxArgs.push(cli);
      spawnSync(TMUX, tmuxArgs);
    } else {
      console.log(`Tmux session "${session}" already exists — skipping CLI launch (attach with: meshterm agent attach --name ${name})`);
    }

    // 3. Start mesh-client in background
    const meshClientPath = join(import.meta.dir, "../client/mesh-client.ts");
    const proc = Bun.spawn([
      process.execPath, meshClientPath,
      "--agent", name,
      "--session", session,
      "--mesh", mesh,
      "--type", opts.type!,
      "--host", opts.host!,
    ], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, MESH_SECRET: secret },
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
      profile: PROFILE ?? "default",
      startedAt: new Date().toISOString(),
    };
    saveState(state);

    console.log(`✅ Agent ${name} started (session: ${session}, mesh-client PID: ${proc.pid})`);
    break;
  }

  case "stop": {
    const { values: opts, positionals: stopPos } = parseArgs({
      args: cmdArgs,
      options: {
        name: { type: "string" },
        "kill-session": { type: "boolean", default: false },
      },
      allowPositionals: true,
    });

    const stopName = opts.name ?? stopPos[0];
    if (!stopName) {
      console.error("Usage: meshterm agent stop --name <name> [--kill-session]  (or: meshterm agent stop <name>)");
      process.exit(1);
    }

    const state = loadState();
    const entry = state[stopName];
    if (!entry) {
      console.error(`Agent "${stopName}" not found in state.`);
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
      spawnSync(TMUX, ["kill-session", "-t", entry.session]);
      console.log(`Killed tmux session: ${entry.session}`);
    }

    delete state[stopName];
    saveState(state);
    console.log(`✅ Agent ${stopName} stopped`);
    break;
  }

  case "list": {
    const state = loadState();
    const entries = Object.values(state).filter(
      e => !PROFILE || (e.profile ?? "default") === PROFILE
    );
    if (entries.length === 0) {
      console.log("No agents running.");
      break;
    }
    for (const entry of entries) {
      const alive = isAlive(entry.meshClientPid);
      const sessionUp = tmuxSessionExists(entry.session);
      const status = alive && sessionUp ? "✅ running" : alive ? "⚠️  no tmux" : sessionUp ? "⚠️  no mesh-client" : "❌ dead";
      const prof = entry.profile && entry.profile !== "default" ? `  profile=${entry.profile}` : "";
      console.log(`${entry.name}  session=${entry.session}  pid=${entry.meshClientPid}  ${status}${prof}  started=${entry.startedAt}`);
    }
    break;
  }

  case "attach": {
    const { values: opts, positionals: attachPos } = parseArgs({
      args: cmdArgs,
      options: {
        name: { type: "string" },
      },
      allowPositionals: true,
    });

    const attachName = opts.name ?? attachPos[0];
    if (!attachName) {
      console.error("Usage: meshterm agent attach --name <name>  (or: meshterm agent attach <name>)");
      process.exit(1);
    }

    const state = loadState();
    const entry = state[attachName];
    if (!entry) {
      console.error(`Agent "${attachName}" not found. Run: meshterm agent list`);
      process.exit(1);
    }

    if (!tmuxSessionExists(entry.session)) {
      console.error(`Tmux session "${entry.session}" not found.`);
      process.exit(1);
    }

    // Replace this process with tmux attach
    const result = spawnSync(TMUX, ["attach", "-t", entry.session], { stdio: "inherit" });
    process.exit(result.exitCode ?? 0);
  }

  case "register": {
    const { values: opts } = parseArgs({
      args: cmdArgs,
      options: {
        name: { type: "string" },
        type: { type: "string", default: "worker" },
        host: { type: "string", default: "remote" },
        delivery: { type: "string", default: "poll" },
        "webhook-url": { type: "string" },
        "webhook-secret": { type: "string" },
      },
    });

    const name = opts.name;
    if (!name) {
      console.error("Usage: meshterm agent register --name <name> [--delivery webhook --webhook-url <url>] [--webhook-secret <secret>]");
      process.exit(1);
    }

    const mesh = meshConfig?.server ?? "http://localhost:4200";
    const secret = meshConfig?.secret ?? process.env.MESH_SECRET ?? "";
    const payload: Record<string, string> = { name, type: opts.type as string, host: opts.host as string };
    if (opts.delivery) payload.delivery_method = opts.delivery as string;
    if (opts["webhook-url"]) payload.webhook_url = opts["webhook-url"] as string;
    if (opts["webhook-secret"]) payload.webhook_secret = opts["webhook-secret"] as string;

    const res = await fetch(`${mesh}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mesh-secret": secret },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅ Registered ${name} (delivery: ${opts.delivery}${opts["webhook-url"] ? `, url: ${opts["webhook-url"]}` : ""})`);
    } else {
      console.error(`❌ ${data.error}`);
    }
    break;
  }

  default:
    console.log("Usage: meshterm agent <start|stop|list|attach|register>");
    console.log("  start    --name <name> --cli <command> --session <session> [--mesh <url>] [--secret <secret>]");
    console.log("  stop     --name <name> [--kill-session]");
    console.log("  attach   --name <name>");
    console.log("  register --name <name> [--delivery webhook --webhook-url <url>] [--webhook-secret <secret>]");
    console.log("  list");
  }
}

// Run directly if this is the entry point
if (import.meta.main) {
  runAgent();
}

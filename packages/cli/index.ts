#!/usr/bin/env bun
/**
 * meshterm CLI
 * Unified interface for mesh server, client, and messaging
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".meshterm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  server: string;
  secret: string;
  agent: string;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(config: Config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function meshFetch(path: string, config: Config, opts?: RequestInit) {
  const headers = {
    "content-type": "application/json",
    "x-mesh-secret": config.secret,
    ...opts?.headers,
  };
  const res = await fetch(`${config.server}${path}`, { ...opts, headers });
  if (!res.ok) {
    throw new Error(`Mesh ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    server: { type: "string" },
    key: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    poll: { type: "string", default: "5000" },
    type: { type: "string", default: "unknown" },
    host: { type: "string", default: "unknown" },
  },
  allowPositionals: true,
});

const [command, ...rest] = positionals;

// --- Commands ---

switch (command) {
  case "init": {
    const server = args.server ?? prompt("Mesh server URL:", "http://localhost:4200");
    const secret = args.key ?? prompt("API key:", "");
    const agent = args.agent ?? prompt("Agent name:", "my-agent");

    if (!server || !secret || !agent) {
      console.error("❌ All fields required");
      process.exit(1);
    }

    const config: Config = { server, secret, agent };
    saveConfig(config);
    console.log(`✅ Config saved to ${CONFIG_FILE}`);
    console.log(JSON.stringify(config, null, 2));
    break;
  }

  case "send": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const [to, ...bodyParts] = rest;
    const body = bodyParts.join(" ");
    if (!to || !body) {
      console.error("Usage: meshterm send <to_agent> <message>");
      process.exit(1);
    }

    const result = await meshFetch(
      "/messages",
      config,
      {
        method: "POST",
        body: JSON.stringify({ from_agent: config.agent, to_agent: to, body }),
      }
    );
    console.log(`✅ Sent to ${to}`);
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "poll": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const msgs = await meshFetch(`/messages/${config.agent}?unread=true`, config);
    if (!msgs.length) {
      console.log("📭 No unread messages");
    } else {
      for (const m of msgs) {
        console.log(`📨 [${m.from_agent}] ${m.body}`);
        // Mark as read
        await meshFetch(`/messages/${m.id}/read`, config, { method: "PATCH" });
      }
    }
    break;
  }

  case "agents": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const agents = await meshFetch("/agents", config);
    console.log(`🤖 ${agents.length} registered agents:\n`);
    for (const a of agents) {
      console.log(`  ${a.name} (${a.type}@${a.host}) — last seen ${a.last_seen}`);
    }
    break;
  }

  case "status": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    // Get agents
    const agents = await meshFetch("/agents", config);
    
    // Get unread messages
    const msgs = await meshFetch(`/messages/${config.agent}?unread=true`, config);
    
    // Get health
    const health = await fetch(`${config.server}/health`).then(r => r.json());

    console.log(`🕸️  Mesh Status\n`);
    console.log(`Server: ${config.server}`);
    console.log(`Agent: ${config.agent}`);
    console.log(`Health: ${health.ok ? "✅ OK" : "❌ DOWN"}`);
    console.log(`Total agents: ${agents.length}`);
    console.log(`Total messages: ${health.messages ?? 0}`);
    console.log(`Unread for you: ${msgs.length}\n`);

    if (agents.length > 0) {
      console.log(`Registered agents:`);
      for (const a of agents) {
        console.log(`  • ${a.name} (${a.type}@${a.host})`);
      }
    }
    break;
  }

  case "server": {
    const [subcommand] = rest;
    if (subcommand === "start") {
      console.log("🕸️  Starting mesh server...");
      const serverPath = join(import.meta.dir, "../server/server.ts");
      const proc = spawn("bun", ["run", serverPath], {
        stdio: "inherit",
        env: process.env,
      });
      proc.on("exit", (code) => process.exit(code ?? 0));
    } else {
      console.log("Usage: meshterm server start");
    }
    break;
  }

  case "client": {
    const [subcommand] = rest;
    if (subcommand === "start") {
      const config = loadConfig();
      if (!config) {
        console.error("❌ Not configured. Run: meshterm init");
        process.exit(1);
      }

      const agent = args.agent ?? config.agent;
      const session = args.session;
      if (!session) {
        console.error("Usage: meshterm client start --agent <name> --session <tmux-session>");
        process.exit(1);
      }

      console.log(`🕸️  Starting mesh client for ${agent} (tmux session: ${session})`);
      const clientPath = join(import.meta.dir, "../client/mesh-client.ts");
      const proc = spawn(
        "bun",
        [
          "run",
          clientPath,
          "--agent", agent,
          "--session", session,
          "--mesh", config.server,
          "--secret", config.secret,
          "--poll", args.poll ?? "5000",
          "--type", args.type ?? "unknown",
          "--host", args.host ?? "unknown",
        ],
        {
          stdio: "inherit",
          env: process.env,
        }
      );
      proc.on("exit", (code) => process.exit(code ?? 0));
    } else {
      console.log("Usage: meshterm client start --agent <name> --session <tmux-session>");
    }
    break;
  }

  case "tui": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const tuiPath = join(import.meta.dir, "../tui/index.ts");
    const proc = spawn("bun", ["run", tuiPath], {
      stdio: "inherit",
      env: process.env,
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  case "mcp": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const mcpPath = join(import.meta.dir, "../mcp/index.ts");
    const proc = spawn("bun", ["run", mcpPath], {
      stdio: "inherit",
      env: process.env,
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  default:
    console.log(`meshterm — Agent-agnostic communication layer

Commands:
  init                                    Configure meshterm (server URL, API key, agent name)
  send <to> <message>                     Send a message to another agent
  poll                                    Check for unread messages
  agents                                  List registered agents
  status                                  Show mesh status (agents, messages, health)
  tui                                     Launch terminal dashboard
  mcp                                     Start MCP server (stdio transport for AI assistants)
  server start                            Start the mesh server
  client start --agent <name> --session <tmux>  Start the tmux inject client

Examples:
  meshterm init --server https://mesh.example.com --key xxx --agent kaze
  meshterm send kiro-mac "refactor auth module"
  meshterm poll
  meshterm tui
  meshterm mcp
  meshterm client start --agent kiro-vps --session kiro
`);
}

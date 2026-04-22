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
    broadcast: { type: "boolean", default: false },
    agents: { type: "string" },
    priority: { type: "string" },
    fallback: { type: "string", default: "queue" },
    capabilities: { type: "string" },
    members: { type: "string" },
    mode: { type: "string" },
    moderator: { type: "string" },
    limit: { type: "string" },
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
      console.error("Usage: meshterm send <to_agent> <message> [--broadcast]");
      process.exit(1);
    }

    const payload: any = { 
      from_agent: config.agent, 
      to_agent: to, 
      body 
    };
    
    if (args.broadcast) {
      payload.broadcast = true;
    }

    const result = await meshFetch(
      "/messages",
      config,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
    
    if (result.broadcast) {
      console.log(`✅ Broadcast to ${result.count} agents in ${to}`);
    } else if (result.resolved_to) {
      console.log(`✅ Sent to ${to} → resolved to ${result.resolved_to}`);
    } else {
      console.log(`✅ Sent to ${to}`);
    }
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

  case "roles": {
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    const roles = await meshFetch("/roles", config);
    if (!roles.length) {
      console.log("No roles defined");
    } else {
      console.log(`🎭 ${roles.length} role(s):\n`);
      for (const r of roles) {
        console.log(`  ${r.name}`);
        console.log(`    Agents: ${r.agents.join(", ")}`);
        console.log(`    Priority: ${r.priority.join(", ")}`);
        console.log(`    Fallback: ${r.fallback}`);
        if (r.capabilities.length > 0) {
          console.log(`    Capabilities: ${r.capabilities.join(", ")}`);
        }
      }
    }
    break;
  }

  case "role": {
    const [subcommand, ...roleRest] = rest;
    
    if (subcommand === "create") {
      const config = loadConfig();
      if (!config) {
        console.error("❌ Not configured. Run: meshterm init");
        process.exit(1);
      }

      const [name] = roleRest;
      if (!name || !args.agents) {
        console.error("Usage: meshterm role create <name> --agents a,b,c [--priority a,b,c] [--fallback queue|reject] [--capabilities x,y,z]");
        process.exit(1);
      }

      const agentList = args.agents.split(",").map(s => s.trim());
      const priorityList = args.priority ? args.priority.split(",").map(s => s.trim()) : agentList;
      const capabilitiesList = args.capabilities ? args.capabilities.split(",").map(s => s.trim()) : [];
      const fallback = args.fallback ?? "queue";

      if (!["queue", "reject"].includes(fallback)) {
        console.error("❌ Fallback must be 'queue' or 'reject'");
        process.exit(1);
      }

      const result = await meshFetch("/roles", config, {
        method: "POST",
        body: JSON.stringify({
          name,
          agents: agentList,
          priority: priorityList,
          fallback,
          capabilities: capabilitiesList,
        }),
      });

      console.log(`✅ Role '${name}' created`);
      console.log(JSON.stringify(result.role, null, 2));
    } else {
      console.log("Usage: meshterm role create <name> --agents a,b,c [--priority a,b,c] [--fallback queue|reject] [--capabilities x,y,z]");
    }
    break;
  }

  case "room": {
    const [subcommand, ...roomRest] = rest;
    const config = loadConfig();
    if (!config) {
      console.error("❌ Not configured. Run: meshterm init");
      process.exit(1);
    }

    if (subcommand === "create") {
      const [name] = roomRest;
      if (!name || !args.members || !args.mode) {
        console.error("Usage: meshterm room create <name> --members a,b,c --mode free-form|round-robin|reactive|moderated [--moderator agent]");
        process.exit(1);
      }

      const memberList = args.members.split(",").map(s => s.trim());
      const mode = args.mode;

      if (!["free-form", "round-robin", "reactive", "moderated"].includes(mode)) {
        console.error("❌ Mode must be free-form, round-robin, reactive, or moderated");
        process.exit(1);
      }

      if (mode === "moderated" && !args.moderator) {
        console.error("❌ Moderator required for moderated mode");
        process.exit(1);
      }

      const payload: any = {
        name,
        members: memberList,
        mode,
      };

      if (args.moderator) {
        payload.moderator = args.moderator;
      }

      const result = await meshFetch("/rooms", config, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      console.log(`✅ Room '${name}' created`);
      console.log(JSON.stringify(result.room, null, 2));
    } else if (subcommand === "list") {
      const rooms = await meshFetch("/rooms", config);
      if (!rooms.length) {
        console.log("No rooms available");
      } else {
        console.log(`🚪 ${rooms.length} room(s):\n`);
        for (const r of rooms) {
          console.log(`  ${r.name} (${r.mode})`);
          console.log(`    Members: ${r.members.join(", ")}`);
          if (r.moderator) {
            console.log(`    Moderator: ${r.moderator}`);
          }
          console.log(`    Created: ${r.created_at}`);
          console.log(`    Last activity: ${r.last_activity}`);
        }
      }
    } else if (subcommand === "send") {
      const [name, ...bodyParts] = roomRest;
      const body = bodyParts.join(" ");
      if (!name || !body) {
        console.error("Usage: meshterm room send <name> <message>");
        process.exit(1);
      }

      const result = await meshFetch(`/rooms/${encodeURIComponent(name)}/messages`, config, {
        method: "POST",
        body: JSON.stringify({
          from_agent: config.agent,
          body,
        }),
      });

      console.log(`✅ Message sent to room '${name}'`);
      console.log(JSON.stringify(result.message, null, 2));
    } else if (subcommand === "history") {
      const [name] = roomRest;
      if (!name) {
        console.error("Usage: meshterm room history <name> [--limit 50]");
        process.exit(1);
      }

      const limit = args.limit ?? "50";
      const msgs = await meshFetch(`/rooms/${encodeURIComponent(name)}/messages?limit=${limit}`, config);
      
      if (!msgs.length) {
        console.log(`📭 No messages in room '${name}'`);
      } else {
        console.log(`💬 ${msgs.length} message(s) in '${name}':\n`);
        for (const m of msgs) {
          console.log(`[${m.created_at}] ${m.from_agent}: ${m.body}`);
        }
      }
    } else if (subcommand === "join") {
      const [name] = roomRest;
      if (!name) {
        console.error("Usage: meshterm room join <name>");
        process.exit(1);
      }

      const result = await meshFetch(`/rooms/${encodeURIComponent(name)}/join`, config, {
        method: "POST",
        body: JSON.stringify({ agent: config.agent }),
      });

      console.log(`✅ Joined room '${name}'`);
      console.log(JSON.stringify(result.room, null, 2));
    } else if (subcommand === "leave") {
      const [name] = roomRest;
      if (!name) {
        console.error("Usage: meshterm room leave <name>");
        process.exit(1);
      }

      const result = await meshFetch(`/rooms/${encodeURIComponent(name)}/leave`, config, {
        method: "POST",
        body: JSON.stringify({ agent: config.agent }),
      });

      console.log(`✅ Left room '${name}'`);
      console.log(JSON.stringify(result.room, null, 2));
    } else if (subcommand === "close") {
      const [name] = roomRest;
      if (!name) {
        console.error("Usage: meshterm room close <name>");
        process.exit(1);
      }

      await meshFetch(`/rooms/${encodeURIComponent(name)}`, config, {
        method: "DELETE",
      });

      console.log(`✅ Room '${name}' closed`);
    } else {
      console.log("Usage: meshterm room <create|list|send|history|join|leave|close>");
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
  send <to> <message> [--broadcast]       Send a message to another agent or role
  poll                                    Check for unread messages
  agents                                  List registered agents
  roles                                   List all roles
  role create <name> --agents a,b,c       Create a new role
    [--priority a,b,c]                    Agent priority order (default: same as agents)
    [--fallback queue|reject]             Fallback when no agents online (default: queue)
    [--capabilities x,y,z]                Role capabilities (optional)
  room create <name> --members a,b,c      Create a new room
    --mode <mode>                         Room mode: free-form, round-robin, reactive, moderated
    [--moderator <agent>]                 Moderator (required for moderated mode)
  room list                               List all rooms
  room send <name> <message>              Send message to room
  room history <name> [--limit 50]        View room message history
  room join <name>                        Join a room
  room leave <name>                       Leave a room
  room close <name>                       Close/delete a room
  status                                  Show mesh status (agents, messages, health)
  tui                                     Launch terminal dashboard
  mcp                                     Start MCP server (stdio transport for AI assistants)
  server start                            Start the mesh server
  client start --agent <name> --session <tmux>  Start the tmux inject client

Examples:
  meshterm init --server https://mesh.example.com --key sk_xxx --agent my-agent
  meshterm send agent-1 "refactor auth module"
  meshterm send role:coder "review auth module"
  meshterm send role:coder --broadcast "system update in 5 min"
  meshterm role create coder --agents agent-1,agent-2 --priority agent-1,agent-2 --fallback queue
  meshterm room create planning --members agent-1,agent-2,agent-3 --mode free-form
  meshterm room send planning "Let's discuss the auth refactor"
  meshterm room history planning
  meshterm roles
  meshterm poll
  meshterm tui
  meshterm mcp
  meshterm client start --agent agent-1 --session my-tmux
`);
}

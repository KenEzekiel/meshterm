#!/usr/bin/env bun
/**
 * meshterm MCP Server
 * Model Context Protocol server for meshterm (stdio transport)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".meshterm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  server: string;
  secret: string;
  agent: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Load config
function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`Config not found. Run: meshterm init`);
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to load config: ${err}`);
  }
}

// Mesh API helper
async function meshFetch(path: string, config: Config, opts?: RequestInit) {
  const headers = {
    "content-type": "application/json",
    "x-mesh-secret": config.secret,
    ...opts?.headers,
  };
  const res = await fetch(`${config.server}${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mesh ${res.status}: ${text}`);
  }
  return res.json();
}

// MCP Tools
const TOOLS = [
  {
    name: "mesh_send",
    description: "Send a message to another agent or role on the mesh. Use 'role:xxx' to send to a role (e.g., 'role:coder'). Add broadcast flag to send to all agents in a role.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target agent name or role (use 'role:xxx' for roles, e.g., 'role:coder')",
        },
        message: {
          type: "string",
          description: "Message body to send",
        },
        broadcast: {
          type: "boolean",
          description: "If true and 'to' is a role, send to all agents in that role (default: false)",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "mesh_reply",
    description: "Reply to the last received message (semantically a reply, functionally same as mesh_send). Supports role addressing with 'role:xxx'.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target agent name or role (use 'role:xxx' for roles)",
        },
        message: {
          type: "string",
          description: "Reply message body",
        },
        broadcast: {
          type: "boolean",
          description: "If true and 'to' is a role, send to all agents in that role (default: false)",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "mesh_poll",
    description: "Check for unread messages and mark them as read",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "mesh_agents",
    description: "List all registered agents on the mesh",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "mesh_status",
    description: "Get mesh server health and overview (agent count, message count, unread count)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// Tool handlers
async function handleToolCall(name: string, args: any, config: Config): Promise<string> {
  switch (name) {
    case "mesh_send":
    case "mesh_reply": {
      const { to, message } = args;
      if (!to || !message) {
        throw new Error("Missing required parameters: to, message");
      }
      const result = await meshFetch("/messages", config, {
        method: "POST",
        body: JSON.stringify({
          from_agent: config.agent,
          to_agent: to,
          body: message,
        }),
      });
      return `✅ Message sent to ${to}\nMessage ID: ${result.id}`;
    }

    case "mesh_poll": {
      const msgs = await meshFetch(`/messages/${config.agent}?unread=true`, config);
      if (!msgs.length) {
        return "📭 No unread messages";
      }
      
      // Mark all as read
      for (const m of msgs) {
        await meshFetch(`/messages/${m.id}/read`, config, { method: "PATCH" });
      }

      const formatted = msgs.map((m: any) => 
        `📨 From: ${m.from_agent}\n   Time: ${m.created_at}\n   Message: ${m.body}`
      ).join("\n\n");
      
      return `${msgs.length} unread message(s):\n\n${formatted}`;
    }

    case "mesh_agents": {
      const agents = await meshFetch("/agents", config);
      if (!agents.length) {
        return "No agents registered";
      }
      
      const formatted = agents.map((a: any) => 
        `• ${a.name} (${a.type}@${a.host})\n  Last seen: ${a.last_seen}`
      ).join("\n");
      
      return `🤖 ${agents.length} registered agent(s):\n\n${formatted}`;
    }

    case "mesh_status": {
      const agents = await meshFetch("/agents", config);
      const msgs = await meshFetch(`/messages/${config.agent}?unread=true`, config);
      const health = await fetch(`${config.server}/health`).then(r => r.json());

      return `🕸️  Mesh Status

Server: ${config.server}
Your agent: ${config.agent}
Health: ${health.ok ? "✅ OK" : "❌ DOWN"}
Total agents: ${agents.length}
Total messages: ${health.messages ?? 0}
Unread for you: ${msgs.length}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC handler
async function handleRequest(req: JsonRpcRequest, config: Config): Promise<JsonRpcResponse | null> {
  const { method, id, params } = req;

  // Notifications (no response)
  if (method === "notifications/initialized") {
    console.error("[MCP] Client initialized");
    return null;
  }

  // Must have id for requests
  if (id === undefined) {
    console.error(`[MCP] Request without id: ${method}`);
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "meshterm-mcp",
              version: "1.0.0",
            },
          },
        };
      }

      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS,
          },
        };
      }

      case "tools/call": {
        const { name, arguments: args } = params;
        const result = await handleToolCall(name, args, config);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: result,
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (err: any) {
    console.error(`[MCP] Error handling ${method}:`, err);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err.message ?? "Internal error",
        data: err.stack,
      },
    };
  }
}

// Main
async function main() {
  console.error("[MCP] meshterm MCP server starting...");

  // Load config
  let config: Config;
  try {
    config = loadConfig();
    console.error(`[MCP] Loaded config: agent=${config.agent}, server=${config.server}`);
  } catch (err: any) {
    console.error(`[MCP] Fatal: ${err.message}`);
    process.exit(1);
  }

  // Register agent
  try {
    await meshFetch("/agents/register", config, {
      method: "POST",
      body: JSON.stringify({
        name: config.agent,
        type: "mcp",
        host: "localhost",
      }),
    });
    console.error(`[MCP] Registered agent: ${config.agent}`);
  } catch (err: any) {
    console.error(`[MCP] Warning: Failed to register agent: ${err.message}`);
  }

  // Read stdin line by line
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  console.error("[MCP] Ready for JSON-RPC requests on stdin");

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const req: JsonRpcRequest = JSON.parse(line);
      const res = await handleRequest(req, config);
      if (res) {
        console.log(JSON.stringify(res));
      }
    } catch (err: any) {
      console.error(`[MCP] Failed to parse request: ${err.message}`);
      console.error(`[MCP] Line: ${line}`);
    }
  });

  rl.on("close", () => {
    console.error("[MCP] stdin closed, exiting");
    process.exit(0);
  });
}

main();

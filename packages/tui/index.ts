#!/usr/bin/env bun
/**
 * meshterm TUI
 * Terminal dashboard for mesh server monitoring
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".meshterm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  server: string;
  secret: string;
  agent: string;
}

interface Agent {
  name: string;
  type: string;
  host: string;
  last_seen: string;
}

interface Message {
  id: number;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read: boolean;
}

interface State {
  agents: Agent[];
  messages: Message[];
  connected: boolean;
  error: string | null;
  totalMessages: number;
  unreadCount: number;
  focusedPanel: "agents" | "messages";
}

// ANSI escape codes
const CLEAR = "\x1b[2J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchData(config: Config, state: State): Promise<void> {
  try {
    const headers = {
      "content-type": "application/json",
      "x-mesh-secret": config.secret,
    };

    // Fetch health
    const healthRes = await fetch(`${config.server}/health`, { headers });
    const health = await healthRes.json();

    // Fetch agents
    const agentsRes = await fetch(`${config.server}/agents`, { headers });
    const agents = await agentsRes.json();

    // Fetch messages history
    const messagesRes = await fetch(
      `${config.server}/messages/${config.agent}/history?limit=20`,
      { headers }
    );
    const messages = await messagesRes.json();

    // Fetch unread count
    const unreadRes = await fetch(
      `${config.server}/messages/${config.agent}?unread=true`,
      { headers }
    );
    const unread = await unreadRes.json();

    state.agents = agents;
    state.messages = messages;
    state.totalMessages = health.messages ?? 0;
    state.unreadCount = unread.length;
    state.connected = true;
    state.error = null;
  } catch (err) {
    state.connected = false;
    state.error = err instanceof Error ? err.message : "Connection failed";
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function formatTimestamp(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function isOnline(lastSeen: string): boolean {
  const date = new Date(lastSeen);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  return diff < 30000; // 30 seconds
}

function render(config: Config, state: State): void {
  const { columns, rows } = process.stdout;
  const width = columns;
  const height = rows;

  let output = CLEAR + HIDE_CURSOR;

  // Header
  const headerLine = 1;
  const statusColor = state.connected ? GREEN : RED;
  const statusText = state.connected ? "CONNECTED" : "DISCONNECTED";
  output += moveCursor(headerLine, 1);
  output += `${YELLOW}${BOLD}meshterm${RESET} ${DIM}${config.server}${RESET} ${statusColor}●${RESET} ${statusText}`;

  // Draw top border
  const borderLine = 2;
  output += moveCursor(borderLine, 1);
  output += "┌" + "─".repeat(width - 2) + "┐";

  // Agents panel (left half)
  const agentsPanelStart = 3;
  const agentsPanelHeight = height - 5; // Leave room for status bar
  const agentsPanelWidth = Math.floor(width / 2) - 1;

  output += moveCursor(agentsPanelStart, 1);
  output += `│ ${YELLOW}Agents${RESET} ${state.focusedPanel === "agents" ? "◀" : " "}`;
  output += " ".repeat(agentsPanelWidth - 10) + "│";

  for (let i = 0; i < agentsPanelHeight - 1; i++) {
    const agent = state.agents[i];
    output += moveCursor(agentsPanelStart + 1 + i, 1);
    output += "│ ";

    if (agent) {
      const online = isOnline(agent.last_seen);
      const statusColor = online ? GREEN : RED;
      const statusText = online ? "●" : "○";
      const name = truncate(agent.name, 15);
      const type = truncate(agent.type, 8);
      const host = truncate(agent.host, 10);
      const lastSeen = formatTimestamp(agent.last_seen);

      output += `${statusColor}${statusText}${RESET} ${name.padEnd(15)} ${DIM}${type}${RESET}`;
    } else {
      output += " ".repeat(agentsPanelWidth - 2);
    }

    output += " ".repeat(Math.max(0, agentsPanelWidth - 2 - (agent ? 26 : 0))) + "│";
  }

  // Middle divider
  for (let i = borderLine; i < height - 2; i++) {
    output += moveCursor(i, agentsPanelWidth + 2);
    output += "│";
  }

  // Messages panel (right half)
  const messagesPanelStart = 3;
  const messagesPanelWidth = width - agentsPanelWidth - 3;

  output += moveCursor(messagesPanelStart, agentsPanelWidth + 3);
  output += `${YELLOW}Messages${RESET} ${state.focusedPanel === "messages" ? "◀" : " "}`;

  for (let i = 0; i < agentsPanelHeight - 1; i++) {
    const msg = state.messages[i];
    output += moveCursor(messagesPanelStart + 1 + i, agentsPanelWidth + 3);

    if (msg) {
      const from = truncate(msg.from_agent, 10);
      const to = truncate(msg.to_agent, 10);
      const body = truncate(msg.body, messagesPanelWidth - 30);
      const timestamp = formatTimestamp(msg.created_at);

      output += `${from}→${to} ${body} ${DIM}${timestamp}${RESET}`;
    } else {
      output += " ".repeat(messagesPanelWidth - 1);
    }
  }

  // Bottom border
  const bottomBorderLine = height - 2;
  output += moveCursor(bottomBorderLine, 1);
  output += "├" + "─".repeat(agentsPanelWidth) + "┼" + "─".repeat(width - agentsPanelWidth - 3) + "┤";

  // Status bar
  const statusBarLine = height - 1;
  output += moveCursor(statusBarLine, 1);
  const statusBar = `│ Agents: ${state.agents.length} │ Messages: ${state.totalMessages} │ Unread: ${state.unreadCount} │ Refresh: 3s │ q:quit r:refresh tab:focus`;
  output += statusBar + " ".repeat(Math.max(0, width - statusBar.length - 1)) + "│";

  // Bottom border close
  output += moveCursor(height, 1);
  output += "└" + "─".repeat(width - 2) + "┘";

  // Error display
  if (state.error) {
    const errorLine = height - 3;
    output += moveCursor(errorLine, 3);
    output += `${RED}Error: ${truncate(state.error, width - 10)}${RESET}`;
  }

  process.stdout.write(output);
}

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error("❌ Not configured. Run: meshterm init");
    process.exit(1);
  }

  const state: State = {
    agents: [],
    messages: [],
    connected: false,
    error: null,
    totalMessages: 0,
    unreadCount: 0,
    focusedPanel: "agents",
  };

  // Enable raw mode for keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Keyboard handler
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\u0003") {
      // q or Ctrl+C
      cleanup();
      process.exit(0);
    } else if (key === "r") {
      // Force refresh
      fetchData(config, state).then(() => render(config, state));
    } else if (key === "\t") {
      // Tab to switch focus
      state.focusedPanel = state.focusedPanel === "agents" ? "messages" : "agents";
      render(config, state);
    }
  });

  // Cleanup on exit
  function cleanup() {
    process.stdout.write(SHOW_CURSOR + CLEAR + moveCursor(1, 1));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  // Initial fetch and render
  await fetchData(config, state);
  render(config, state);

  // Auto-refresh every 3 seconds
  setInterval(async () => {
    await fetchData(config, state);
    render(config, state);
  }, 3000);
}

main();

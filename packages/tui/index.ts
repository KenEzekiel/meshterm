#!/usr/bin/env bun
/**
 * meshterm TUI
 * Terminal dashboard for mesh server monitoring
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".meshterm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config { server: string; secret: string; agent: string; }
interface Agent { name: string; type: string; host: string; last_seen: string; }
interface Message { id: string; from_agent: string; to_agent: string; body: string; created_at: string; read: boolean; }
interface Room { name: string; members: string[]; mode: string; last_activity: string; }

interface State {
  agents: Agent[];
  messages: Message[];
  rooms: Room[];
  connected: boolean;
  error: string | null;
  totalMessages: number;
  unreadCount: number;
  focusedPanel: number;
  lastRefresh: Date;
}

// ANSI
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const RST = "\x1b[0m";
const GRN = "\x1b[32m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const CYN = "\x1b[36m";
const DIM = "\x1b[2m";
const BLD = "\x1b[1m";
const INV = "\x1b[7m";
const ERASE_LINE = "\x1b[2K";

const mv = (r: number, c: number) => `\x1b[${r};${c}H`;

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch { return null; }
}

async function fetchData(config: Config, state: State): Promise<void> {
  try {
    const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
    const [healthRes, agentsRes, msgsRes, unreadRes, roomsRes] = await Promise.all([
      fetch(`${config.server}/health`, { headers: h }),
      fetch(`${config.server}/agents`, { headers: h }),
      fetch(`${config.server}/messages/${config.agent}/history?limit=20`, { headers: h }),
      fetch(`${config.server}/messages/${config.agent}?unread=true`, { headers: h }),
      fetch(`${config.server}/rooms`, { headers: h }).catch(() => null),
    ]);
    const health = await healthRes.json();
    state.agents = await agentsRes.json();
    state.messages = (await msgsRes.json()).reverse();
    state.unreadCount = (await unreadRes.json()).length;
    state.rooms = roomsRes ? await roomsRes.json() : [];
    state.totalMessages = health.messages ?? 0;
    state.connected = true;
    state.error = null;
    state.lastRefresh = new Date();
  } catch (err: any) {
    state.connected = false;
    state.error = err.message ?? "Connection failed";
  }
}

const trunc = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1) + "…";
const pad = (s: string, n: number) => {
  // Account for ANSI codes in length calculation
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = n - visible.length;
  return diff > 0 ? s + " ".repeat(diff) : s;
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const isOnline = (t: string) => Date.now() - new Date(t).getTime() < 30000;

function render(config: Config, state: State): void {
  const W = process.stdout.columns;
  const H = process.stdout.rows;
  if (W < 40 || H < 10) return;

  let o = mv(1, 1);

  // ── Header ──
  const connIcon = state.connected ? `${GRN}●${RST}` : `${RED}●${RST}`;
  const connText = state.connected ? `${GRN}connected${RST}` : `${RED}disconnected${RST}`;
  const header = ` ${YEL}${BLD}meshterm${RST} ${DIM}${config.server}${RST}  ${connIcon} ${connText}  ${DIM}agent:${RST} ${config.agent}`;
  o += ERASE_LINE + pad(header, W) + "\n";

  // ── Top border ──
  const leftW = Math.floor(W * 0.35);
  const rightW = W - leftW - 1;
  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┬${"─".repeat(rightW)}${RST}\n`;

  // ── Panel headers ──
  const agentHeader = state.focusedPanel === 0
    ? `${INV}${YEL} Agents (${state.agents.length}) ${RST}`
    : `${YEL}${BLD} Agents (${state.agents.length}) ${RST}`;
  const msgHeader = state.focusedPanel === 1
    ? `${INV}${YEL} Messages (${state.totalMessages}) ${RST}`
    : `${YEL}${BLD} Messages (${state.totalMessages}) ${RST}`;

  o += ERASE_LINE + pad(agentHeader, leftW) + `${DIM}│${RST}` + pad(msgHeader, rightW) + "\n";
  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┼${"─".repeat(rightW)}${RST}\n`;

  // ── Content area ──
  const contentH = H - 7; // header + borders + status

  for (let i = 0; i < contentH; i++) {
    // Left: agents
    let left = "";
    if (i < state.agents.length) {
      const a = state.agents[i];
      const on = isOnline(a.last_seen);
      const dot = on ? `${GRN}●${RST}` : `${RED}○${RST}`;
      const name = trunc(a.name, 14);
      const type = `${DIM}${trunc(a.type, 8)}${RST}`;
      const ago = `${DIM}${timeAgo(a.last_seen)}${RST}`;
      left = ` ${dot} ${name.padEnd(14)} ${type} ${ago}`;
    }

    // Right: messages
    let right = "";
    if (i < state.messages.length) {
      const m = state.messages[i];
      const dir = m.from_agent === config.agent ? `${CYN}→${RST}` : `${GRN}←${RST}`;
      const other = m.from_agent === config.agent ? m.to_agent : m.from_agent;
      const name = trunc(other, 12);
      const body = trunc(m.body.replace(/\n/g, " "), rightW - 22);
      const ago = `${DIM}${timeAgo(m.created_at)}${RST}`;
      right = ` ${dir} ${name.padEnd(12)} ${body} ${ago}`;
    }

    o += ERASE_LINE + pad(left, leftW) + `${DIM}│${RST}` + pad(right, rightW) + "\n";
  }

  // ── Rooms row (if any) ──
  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┴${"─".repeat(rightW)}${RST}\n`;

  if (state.rooms.length > 0) {
    const roomList = state.rooms.map(r => `${CYN}#${r.name}${RST}${DIM}(${r.members.length})${RST}`).join("  ");
    o += ERASE_LINE + ` ${YEL}Rooms:${RST} ${roomList}\n`;
  } else {
    o += ERASE_LINE + "\n";
  }

  // ── Status bar ──
  const unreadBadge = state.unreadCount > 0 ? `${RED}${BLD}${state.unreadCount} unread${RST}` : `${DIM}0 unread${RST}`;
  const refreshTime = state.lastRefresh ? `${DIM}${state.lastRefresh.toLocaleTimeString()}${RST}` : "";
  const statusLeft = ` ${state.agents.length} agents  ${state.totalMessages} msgs  ${unreadBadge}  ${refreshTime}`;
  const statusRight = `${DIM}q${RST}:quit  ${DIM}r${RST}:refresh  ${DIM}tab${RST}:focus `;
  const statusGap = Math.max(0, W - statusLeft.replace(/\x1b\[[0-9;]*m/g, "").length - statusRight.replace(/\x1b\[[0-9;]*m/g, "").length);
  o += ERASE_LINE + `${INV}${statusLeft}${" ".repeat(statusGap)}${statusRight}${RST}`;

  // ── Error overlay ──
  if (state.error) {
    o += mv(H - 2, 2) + ERASE_LINE + `${RED}${BLD}Error: ${state.error}${RST}`;
  }

  process.stdout.write(o);
}

async function main() {
  const config = loadConfig();
  if (!config) { console.error("❌ Not configured. Run: meshterm init"); process.exit(1); }

  const state: State = {
    agents: [], messages: [], rooms: [],
    connected: false, error: null,
    totalMessages: 0, unreadCount: 0,
    focusedPanel: 0, lastRefresh: new Date(),
  };

  // Alternate screen + raw mode
  process.stdout.write(ALT_ON + HIDE);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const cleanup = () => {
    process.stdout.write(SHOW + ALT_OFF);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\u0003") { cleanup(); process.exit(0); }
    if (key === "r") fetchData(config, state).then(() => render(config, state));
    if (key === "\t") { state.focusedPanel = (state.focusedPanel + 1) % 2; render(config, state); }
  });

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
  process.stdout.on("resize", () => render(config, state));

  await fetchData(config, state);
  render(config, state);
  setInterval(async () => { await fetchData(config, state); render(config, state); }, 3000);
}

main();

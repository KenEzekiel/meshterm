#!/usr/bin/env bun
/**
 * meshterm TUI - Interactive Control Center
 * Full-featured terminal dashboard for mesh server
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".meshterm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config { server: string; secret: string; agent: string; }
interface Agent { name: string; type: string; host: string; last_seen: string; }
interface Message { id: string; from_agent: string; to_agent: string; body: string; created_at: string; read: boolean; }
interface Room { name: string; members: string[]; mode: string; last_activity: string; }
interface RoomMessage { id: string; room: string; from_agent: string; body: string; created_at: string; }

type View = "dashboard" | "chat" | "room";

interface State {
  view: View;
  agents: Agent[];
  messages: Message[];
  rooms: Room[];
  connected: boolean;
  error: string | null;
  focusedPanel: number;
  selectedAgent: number;
  selectedMessage: number;
  selectedRoom: number;
  chatWith: string | null;
  chatMessages: Message[];
  currentRoom: string | null;
  roomMessages: RoomMessage[];
  inputBuffer: string;
  scrollOffset: number;
}

// ANSI
const ALT_ON = "\x1b[?1049h", ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l", SHOW = "\x1b[?25h";
const RST = "\x1b[0m", GRN = "\x1b[32m", RED = "\x1b[31m", YEL = "\x1b[33m";
const CYN = "\x1b[36m", DIM = "\x1b[2m", BLD = "\x1b[1m", INV = "\x1b[7m";
const ERASE_LINE = "\x1b[2K";
const mv = (r: number, c: number) => `\x1b[${r};${c}H`;

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch { return null; }
}

async function fetchWithCheck(url: string, options: RequestInit): Promise<any> {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    throw new Error(err.message ?? "Request failed");
  }
}

async function fetchDashboard(config: Config, state: State): Promise<void> {
  try {
    const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
    state.agents = await fetchWithCheck(`${config.server}/agents`, { headers: h });
    state.messages = (await fetchWithCheck(`${config.server}/messages/${config.agent}/history?limit=20`, { headers: h })).reverse();
    state.rooms = await fetchWithCheck(`${config.server}/rooms`, { headers: h }).catch(() => []);
    state.connected = true;
    state.error = null;
  } catch (err: any) {
    state.connected = false;
    state.error = err.message ?? "Connection failed";
  }
}

async function fetchChatMessages(config: Config, state: State): Promise<void> {
  if (!state.chatWith) return;
  try {
    const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
    const all = await fetchWithCheck(`${config.server}/messages/${config.agent}/history?limit=100`, { headers: h });
    state.chatMessages = all.filter((m: Message) => 
      (m.from_agent === config.agent && m.to_agent === state.chatWith) ||
      (m.from_agent === state.chatWith && m.to_agent === config.agent)
    );
  } catch (err: any) {
    state.error = err.message;
  }
}

async function fetchRoomMessages(config: Config, state: State): Promise<void> {
  if (!state.currentRoom) return;
  try {
    const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
    state.roomMessages = await fetchWithCheck(`${config.server}/rooms/${state.currentRoom}/messages?limit=100`, { headers: h });
  } catch (err: any) {
    state.error = err.message;
  }
}

async function sendMessage(config: Config, to: string, body: string): Promise<void> {
  const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
  await fetchWithCheck(`${config.server}/messages`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ from_agent: config.agent, to_agent: to, body }),
  });
}

async function sendRoomMessage(config: Config, room: string, body: string): Promise<void> {
  const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
  await fetchWithCheck(`${config.server}/rooms/${room}/messages`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ from_agent: config.agent, body }),
  });
}

async function createRoom(config: Config, name: string, members: string[]): Promise<void> {
  const h = { "content-type": "application/json", "x-mesh-secret": config.secret };
  await fetchWithCheck(`${config.server}/rooms`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ name, members, mode: "free-form" }),
  });
}

const trunc = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1) + "…";
const pad = (s: string, n: number) => {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return visible.length >= n ? s : s + " ".repeat(n - visible.length);
};
const timeAgo = (iso: string): string => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const isOnline = (t: string) => Date.now() - new Date(t).getTime() < 30000;

function renderDashboard(config: Config, state: State): string {
  const W = process.stdout.columns, H = process.stdout.rows;
  let o = mv(1, 1);

  const connIcon = state.connected ? `${GRN}●${RST}` : `${RED}●${RST}`;
  const connText = state.connected ? `${GRN}connected${RST}` : `${RED}disconnected${RST}`;
  o += ERASE_LINE + pad(` ${YEL}${BLD}meshterm${RST} ${DIM}${config.server}${RST}  ${connIcon} ${connText}`, W) + "\n";

  const leftW = Math.floor(W * 0.35), rightW = W - leftW - 1;
  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┬${"─".repeat(rightW)}${RST}\n`;

  const agentHeader = state.focusedPanel === 0 ? `${INV}${YEL} Agents (${state.agents.length}) ${RST}` : `${YEL}${BLD} Agents ${RST}`;
  const msgHeader = state.focusedPanel === 1 ? `${INV}${YEL} Messages ${RST}` : `${YEL}${BLD} Messages ${RST}`;
  o += ERASE_LINE + pad(agentHeader, leftW) + `${DIM}│${RST}` + pad(msgHeader, rightW) + "\n";
  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┼${"─".repeat(rightW)}${RST}\n`;

  const contentH = H - 7;
  for (let i = 0; i < contentH; i++) {
    let left = "";
    if (i < state.agents.length) {
      const a = state.agents[i];
      const sel = state.focusedPanel === 0 && i === state.selectedAgent;
      const dot = isOnline(a.last_seen) ? `${GRN}●${RST}` : `${RED}○${RST}`;
      const name = trunc(a.name, 14);
      const type = `${DIM}${trunc(a.type, 8)}${RST}`;
      const ago = `${DIM}${timeAgo(a.last_seen)}${RST}`;
      left = sel ? `${INV} ${dot} ${name.padEnd(14)} ${type} ${ago}${RST}` : ` ${dot} ${name.padEnd(14)} ${type} ${ago}`;
    }

    let right = "";
    if (i < state.messages.length) {
      const m = state.messages[i];
      const sel = state.focusedPanel === 1 && i === state.selectedMessage;
      const dir = m.from_agent === config.agent ? `${CYN}→${RST}` : `${GRN}←${RST}`;
      const other = m.from_agent === config.agent ? m.to_agent : m.from_agent;
      const name = trunc(other, 12);
      const body = trunc(m.body.replace(/\n/g, " "), rightW - 22);
      const ago = `${DIM}${timeAgo(m.created_at)}${RST}`;
      right = sel ? `${INV} ${dir} ${name.padEnd(12)} ${body}${RST}` : ` ${dir} ${name.padEnd(12)} ${body} ${ago}`;
    }

    o += ERASE_LINE + pad(left, leftW) + `${DIM}│${RST}` + pad(right, rightW) + "\n";
  }

  o += ERASE_LINE + `${DIM}${"─".repeat(leftW)}┴${"─".repeat(rightW)}${RST}\n`;
  if (state.rooms.length > 0) {
    const roomList = state.rooms.map((r, i) => {
      const sel = state.focusedPanel === 2 && i === state.selectedRoom;
      return sel ? `${INV}${CYN}#${r.name}${RST}` : `${CYN}#${r.name}${RST}${DIM}(${r.members.length})${RST}`;
    }).join("  ");
    o += ERASE_LINE + ` ${YEL}Rooms:${RST} ${roomList}\n`;
  } else {
    o += ERASE_LINE + "\n";
  }

  const statusRight = `${DIM}q${RST}:quit ${DIM}r${RST}:refresh ${DIM}tab${RST}:focus ${DIM}↑↓${RST}:select ${DIM}Enter${RST}:open ${DIM}s${RST}:send ${DIM}c${RST}:room`;
  o += ERASE_LINE + `${INV}${pad(" " + statusRight, W)}${RST}`;

  if (state.error) o += mv(H - 2, 2) + ERASE_LINE + `${RED}${BLD}Error: ${state.error}${RST}`;
  return o;
}

function renderChat(config: Config, state: State): string {
  const W = process.stdout.columns, H = process.stdout.rows;
  let o = mv(1, 1);

  const connIcon = state.connected ? `${GRN}●${RST}` : `${RED}●${RST}`;
  o += ERASE_LINE + pad(` ${YEL}${BLD}meshterm${RST} · chat with ${state.chatWith}  ${connIcon} ${state.connected ? "connected" : "disconnected"}`, W) + "\n";
  o += ERASE_LINE + `${DIM}${"─".repeat(W)}${RST}\n`;

  const contentH = H - 5;
  const bodyW = W - 20; // space for sender + timestamp

  // Build wrapped lines from messages
  const lines: string[] = [];
  for (const m of state.chatMessages) {
    const isMe = m.from_agent === config.agent;
    const sender = isMe ? "you" : m.from_agent;
    const body = m.body.replace(/\n/g, " ");
    const ago = timeAgo(m.created_at);

    if (body.length <= bodyW) {
      lines.push(`${isMe ? CYN : GRN}${sender.padEnd(12)}${RST} ${body} ${DIM}${ago}${RST}`);
    } else {
      // Wrap long messages
      const chunks = [];
      for (let j = 0; j < body.length; j += bodyW) {
        chunks.push(body.slice(j, j + bodyW));
      }
      lines.push(`${isMe ? CYN : GRN}${sender.padEnd(12)}${RST} ${chunks[0]} ${DIM}${ago}${RST}`);
      for (let j = 1; j < chunks.length; j++) {
        lines.push(`${" ".repeat(13)}${chunks[j]}`);
      }
    }
  }

  const visible = lines.slice(Math.max(0, lines.length - contentH - state.scrollOffset), lines.length - state.scrollOffset);
  for (let i = 0; i < contentH; i++) {
    o += ERASE_LINE + (i < visible.length ? ` ${visible[i]}` : "") + "\n";
  }

  o += ERASE_LINE + `${DIM}${"─".repeat(W)}${RST}\n`;
  o += ERASE_LINE + ` ${GRN}>${RST} ${state.inputBuffer}${DIM}${" ".repeat(Math.max(0, W - state.inputBuffer.length - 40))}Enter to send${RST}\n`;
  o += ERASE_LINE + `${INV}${pad(` ${DIM}Esc${RST}:back ${DIM}↑↓${RST}:scroll`, W)}${RST}`;

  if (state.error) o += mv(H - 2, 2) + ERASE_LINE + `${RED}${BLD}Error: ${state.error}${RST}`;
  return o;
}

function renderRoom(config: Config, state: State): string {
  const W = process.stdout.columns, H = process.stdout.rows;
  let o = mv(1, 1);

  const room = state.rooms.find(r => r.name === state.currentRoom);
  const memberCount = room ? room.members.length : 0;
  const connIcon = state.connected ? `${GRN}●${RST}` : `${RED}●${RST}`;
  o += ERASE_LINE + pad(` ${YEL}${BLD}meshterm${RST} · ${CYN}#${state.currentRoom}${RST} ${DIM}(${memberCount} members)${RST}  ${connIcon} ${state.connected ? "connected" : "disconnected"}`, W) + "\n";
  o += ERASE_LINE + `${DIM}${"─".repeat(W)}${RST}\n`;

  const contentH = H - 5;
  const bodyW = W - 20;

  // Build wrapped lines from room messages
  const lines: string[] = [];
  for (const m of state.roomMessages) {
    const body = m.body.replace(/\n/g, " ");
    const ago = timeAgo(m.created_at);

    if (body.length <= bodyW) {
      lines.push(`${CYN}${trunc(m.from_agent, 12).padEnd(12)}${RST} ${body} ${DIM}${ago}${RST}`);
    } else {
      const chunks = [];
      for (let j = 0; j < body.length; j += bodyW) {
        chunks.push(body.slice(j, j + bodyW));
      }
      lines.push(`${CYN}${trunc(m.from_agent, 12).padEnd(12)}${RST} ${chunks[0]} ${DIM}${ago}${RST}`);
      for (let j = 1; j < chunks.length; j++) {
        lines.push(`${" ".repeat(13)}${chunks[j]}`);
      }
    }
  }

  const visible = lines.slice(Math.max(0, lines.length - contentH - state.scrollOffset), lines.length - state.scrollOffset);
  for (let i = 0; i < contentH; i++) {
    o += ERASE_LINE + (i < visible.length ? ` ${visible[i]}` : "") + "\n";
  }

  o += ERASE_LINE + `${DIM}${"─".repeat(W)}${RST}\n`;
  o += ERASE_LINE + ` ${GRN}>${RST} ${state.inputBuffer}${DIM}${" ".repeat(Math.max(0, W - state.inputBuffer.length - 40))}Enter to send${RST}\n`;
  o += ERASE_LINE + `${INV}${pad(` ${DIM}Esc${RST}:back ${DIM}↑↓${RST}:scroll`, W)}${RST}`;

  if (state.error) o += mv(H - 2, 2) + ERASE_LINE + `${RED}${BLD}Error: ${state.error}${RST}`;
  return o;
}

function render(config: Config, state: State): void {
  let output = "";
  if (state.view === "dashboard") output = renderDashboard(config, state);
  else if (state.view === "chat") output = renderChat(config, state);
  else if (state.view === "room") output = renderRoom(config, state);
  process.stdout.write(output);
}

async function main() {
  const config = loadConfig();
  if (!config) { console.error("❌ Not configured. Run: meshterm init"); process.exit(1); }

  const state: State = {
    view: "dashboard",
    agents: [], messages: [], rooms: [],
    connected: false, error: null,
    focusedPanel: 0,
    selectedAgent: 0, selectedMessage: 0, selectedRoom: 0,
    chatWith: null, chatMessages: [],
    currentRoom: null, roomMessages: [],
    inputBuffer: "", scrollOffset: 0,
  };

  process.stdout.write(ALT_ON + HIDE);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const cleanup = () => {
    process.stdout.write(SHOW + ALT_OFF);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  process.stdin.on("data", async (key: string) => {
    // Handle full escape sequences (Bun sends them as single chunks)
    if (key === "\x1b[A") { // Up
      if (state.view === "dashboard") {
        if (state.focusedPanel === 0 && state.selectedAgent > 0) state.selectedAgent--;
        else if (state.focusedPanel === 1 && state.selectedMessage > 0) state.selectedMessage--;
        else if (state.focusedPanel === 2 && state.selectedRoom > 0) state.selectedRoom--;
      } else {
        state.scrollOffset = Math.min(state.scrollOffset + 1, 50);
      }
      render(config, state);
      return;
    }
    if (key === "\x1b[B") { // Down
      if (state.view === "dashboard") {
        if (state.focusedPanel === 0 && state.selectedAgent < state.agents.length - 1) state.selectedAgent++;
        else if (state.focusedPanel === 1 && state.selectedMessage < state.messages.length - 1) state.selectedMessage++;
        else if (state.focusedPanel === 2 && state.selectedRoom < state.rooms.length - 1) state.selectedRoom++;
      } else {
        state.scrollOffset = Math.max(state.scrollOffset - 1, 0);
      }
      render(config, state);
      return;
    }

    // Bare Escape key (for exiting chat/room)
    if (key === "\x1b") {
      if (state.view === "chat" || state.view === "room") {
        state.view = "dashboard";
        state.inputBuffer = "";
        state.scrollOffset = 0;
        await fetchDashboard(config, state);
        render(config, state);
      }
      return;
    }

    // Quit
    if (key === "q" || key === "\u0003") { cleanup(); process.exit(0); }

    // Dashboard controls
    if (state.view === "dashboard") {
      if (key === "r") { await fetchDashboard(config, state); render(config, state); }
      if (key === "\t") { state.focusedPanel = (state.focusedPanel + 1) % 3; render(config, state); }
      if (key === "\r" || key === "\n") {
        if (state.focusedPanel === 0 && state.agents[state.selectedAgent]) {
          state.chatWith = state.agents[state.selectedAgent].name;
          state.view = "chat";
          state.inputBuffer = "";
          state.scrollOffset = 0;
          await fetchChatMessages(config, state);
          render(config, state);
        } else if (state.focusedPanel === 2 && state.rooms[state.selectedRoom]) {
          state.currentRoom = state.rooms[state.selectedRoom].name;
          state.view = "room";
          state.inputBuffer = "";
          state.scrollOffset = 0;
          await fetchRoomMessages(config, state);
          render(config, state);
        }
      }
      if (key === "s") {
        // TODO: Implement compose dialog
        state.error = "Compose not yet implemented - use Enter on agent";
        render(config, state);
      }
      if (key === "c") {
        // TODO: Implement create room dialog
        state.error = "Create room not yet implemented";
        render(config, state);
      }
    }

    // Chat/Room input
    if (state.view === "chat" || state.view === "room") {
      if (key === "\r" || key === "\n") {
        if (state.inputBuffer.trim()) {
          try {
            if (state.view === "chat" && state.chatWith) {
              await sendMessage(config, state.chatWith, state.inputBuffer);
              await fetchChatMessages(config, state);
            } else if (state.view === "room" && state.currentRoom) {
              await sendRoomMessage(config, state.currentRoom, state.inputBuffer);
              await fetchRoomMessages(config, state);
            }
            state.inputBuffer = "";
            state.error = null;
          } catch (err: any) {
            state.error = err.message;
          }
          render(config, state);
        }
      } else if (key === "\x7f" || key === "\x08") { // Backspace
        state.inputBuffer = state.inputBuffer.slice(0, -1);
        render(config, state);
      } else if (key.length === 1 && key >= " ") {
        state.inputBuffer += key;
        render(config, state);
      }
    }
  });

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
  process.stdout.on("resize", () => render(config, state));

  await fetchDashboard(config, state);
  render(config, state);
  
  setInterval(async () => {
    if (state.view === "dashboard") await fetchDashboard(config, state);
    else if (state.view === "chat") await fetchChatMessages(config, state);
    else if (state.view === "room") await fetchRoomMessages(config, state);
    render(config, state);
  }, 3000);
}

main();

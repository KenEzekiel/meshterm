/**
 * Terminal Backend Abstraction
 * 
 * Provides a unified interface for terminal multiplexer operations.
 * Implementations: TmuxBackend, ZellijBackend
 */

import { spawnSync } from "bun";
import { existsSync } from "fs";

export interface TerminalBackend {
  name: string;
  /** Send text + Enter to a session */
  send(session: string, text: string): boolean;
  /** Capture last N lines from a session */
  capture(session: string, lines?: number): string;
  /** Check if a session exists */
  sessionExists(session: string): boolean;
  /** Create a new detached session running a command */
  newSession(session: string, cmd: string, env?: Record<string, string>): boolean;
  /** Kill a session */
  killSession(session: string): boolean;
  /** Attach to a session (replaces current process) */
  attach(session: string): void;
}

// --- Tmux Backend ---

function resolveTmux(): string {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) return p;
  }
  return "tmux";
}

export class TmuxBackend implements TerminalBackend {
  name = "tmux";
  private bin: string;

  constructor() {
    this.bin = resolveTmux();
  }

  send(session: string, text: string): boolean {
    const escaped = text.replace(/'/g, "'\\''");
    const result = spawnSync([this.bin, "send-keys", "-t", session, escaped, "Enter"]);
    if (result.exitCode !== 0) {
      console.error(`tmux send-keys failed: ${result.stderr.toString()}`);
      return false;
    }
    return true;
  }

  capture(session: string, lines: number = 30): string {
    const result = spawnSync([this.bin, "capture-pane", "-t", session, "-p", "-S", `-${lines}`]);
    if (result.exitCode !== 0) return "";
    return result.stdout.toString();
  }

  sessionExists(session: string): boolean {
    const result = spawnSync([this.bin, "has-session", "-t", session]);
    return result.exitCode === 0;
  }

  newSession(session: string, cmd: string, env?: Record<string, string>): boolean {
    const args = ["new-session", "-d", "-s", session];
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push(cmd);
    const result = spawnSync([this.bin, ...args]);
    return result.exitCode === 0;
  }

  killSession(session: string): boolean {
    const result = spawnSync([this.bin, "kill-session", "-t", session]);
    return result.exitCode === 0;
  }

  attach(session: string): void {
    const result = spawnSync([this.bin, "attach", "-t", session], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(result.exitCode ?? 0);
  }
}

// --- Zellij Backend ---

function resolveZellij(): string {
  for (const p of ["/opt/homebrew/bin/zellij", "/usr/local/bin/zellij", `${process.env.HOME}/.cargo/bin/zellij`]) {
    if (existsSync(p)) return p;
  }
  return "zellij";
}

export class ZellijBackend implements TerminalBackend {
  name = "zellij";
  private bin: string;

  constructor() {
    this.bin = resolveZellij();
  }

  send(session: string, text: string): boolean {
    const writeResult = spawnSync([this.bin, "--session", session, "action", "write-chars", text]);
    if (writeResult.exitCode !== 0) {
      console.error(`zellij write-chars failed: ${writeResult.stderr.toString()}`);
      return false;
    }
    Bun.sleepSync(100);
    const enterResult = spawnSync([this.bin, "--session", session, "action", "write", "10"]);
    if (enterResult.exitCode !== 0) {
      console.error(`zellij write Enter failed: ${enterResult.stderr.toString()}`);
      return false;
    }
    return true;
  }

  capture(session: string, lines: number = 30): string {
    const result = spawnSync([this.bin, "--session", session, "action", "dump-screen", "--full"]);
    if (result.exitCode !== 0) return "";
    const allLines = result.stdout.toString().split("\n");
    return allLines.slice(-lines).join("\n");
  }

  sessionExists(session: string): boolean {
    const result = spawnSync([this.bin, "list-sessions", "--no-formatting"]);
    if (result.exitCode !== 0) return false;
    const sessions = result.stdout.toString().split("\n").map(l => l.trim().split(" ")[0]);
    return sessions.includes(session);
  }

  newSession(session: string, cmd: string, env?: Record<string, string>): boolean {
    const tmpLayout = `/tmp/meshterm-zellij-${session}.kdl`;
    const cmdParts = cmd.split(" ");
    const command = cmdParts[0];
    const args = cmdParts.slice(1);
    const argsKdl = args.length > 0 ? `\n        args ${args.map(a => `"${a}"`).join(" ")}` : "";
    const envKdl = env ? Object.entries(env).map(([k, v]) => `\n        env { ${k} "${v}" }`).join("") : "";

    const layout = `layout {\n    pane command="${command}" start_suspended=false {${argsKdl}${envKdl}\n    }\n}\n`;
    require("fs").writeFileSync(tmpLayout, layout);

    const proc = Bun.spawn(["script", "-q", "/dev/null", this.bin, "-s", session, "--new-session-with-layout", tmpLayout], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    proc.unref();

    const maxWait = 10;
    for (let i = 0; i < maxWait; i++) {
      Bun.sleepSync(500);
      if (this.sessionExists(session)) break;
    }

    // Dismiss startup tips overlay (Ctrl+c = byte 3 to disable permanently)
    Bun.sleepSync(500);
    spawnSync([this.bin, "--session", session, "action", "write", "3"]);
    Bun.sleepSync(300);

    try { require("fs").unlinkSync(tmpLayout); } catch {}
    return this.sessionExists(session);
  }

  private dismissOverlay(session: string): void {
    spawnSync([this.bin, "--session", session, "action", "write", "27"]);
  }

  killSession(session: string): boolean {
    const result = spawnSync([this.bin, "kill-session", session]);
    return result.exitCode === 0;
  }

  attach(session: string): void {
    const result = spawnSync([this.bin, "attach", session], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(result.exitCode ?? 0);
  }
}

// --- Factory ---

export type BackendType = "tmux" | "zellij";

export function createBackend(type?: BackendType): TerminalBackend {
  const resolved = type ?? detectBackend();
  switch (resolved) {
    case "zellij":
      return new ZellijBackend();
    case "tmux":
    default:
      return new TmuxBackend();
  }
}

/**
 * Auto-detect which backend to use:
 * 1. MESHTERM_BACKEND env var (explicit override)
 * 2. If inside a zellij session ($ZELLIJ set), use zellij
 * 3. Default to tmux
 */
function detectBackend(): BackendType {
  const explicit = process.env.MESHTERM_BACKEND as BackendType | undefined;
  if (explicit && (explicit === "tmux" || explicit === "zellij")) return explicit;
  if (process.env.ZELLIJ) return "zellij";
  return "tmux";
}

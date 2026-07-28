import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const directories: string[] = [];
const cliPath = join(import.meta.dir, "index.ts");

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "meshterm-cli-"));
  directories.push(directory);
  return directory;
}

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "run", cliPath, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("removed unsafe product surfaces", () => {
  for (const command of [
    "skills",
    "rooms",
    "roles",
    "tasks",
    "tui",
    "daemon",
    "agent",
  ]) {
    test(`${command} fails closed with migration guidance`, () => {
      const result = run([command]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("removed from Meshterm core");
    });
  }
});

describe("credential storage and Desktop integration", () => {
  test("writes v1 client config with mode 0600", () => {
    const directory = tempDirectory();
    const result = run(
      [
        "init",
        "--server",
        "https://mesh.example.test/path",
      ],
      {
        MESHTERM_CONFIG_DIR: directory,
        MESHTERM_CREDENTIAL: `mtk_${"a".repeat(64)}`,
      },
    );
    expect(result.exitCode).toBe(0);
    const path = join(directory, "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      server: "https://mesh.example.test",
      credential: `mtk_${"a".repeat(64)}`,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects profile path traversal", () => {
    const directory = tempDirectory();
    const result = run(
      [
        "init",
        "--server",
        "https://mesh.example.test",
        "--profile",
        "../escape",
      ],
      {
        MESHTERM_CONFIG_DIR: directory,
        MESHTERM_CREDENTIAL: `mtk_${"b".repeat(64)}`,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("invalid profile name");
    expect(existsSync(join(directory, "..", "escape.json"))).toBe(false);
  });

  test("installs an absolute Codex Desktop STDIO command idempotently", () => {
    const directory = tempDirectory();
    const path = join(directory, "config.toml");
    const env = { MESHTERM_CONFIG_DIR: join(directory, "mesh-config") };
    expect(
      run(["setup", "codex-desktop", "--config", path], env).exitCode,
    ).toBe(0);
    expect(
      run(["setup", "codex-desktop", "--config", path], env).exitCode,
    ).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(text.match(/BEGIN MESHTERM MANAGED MCP/g)).toHaveLength(1);
    expect(text).toContain("[mcp_servers.meshterm]");
    expect(text).toContain(process.execPath);
    expect(text).toContain("packages/mcp/index.ts");
    expect(text).not.toContain("mtk_");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("fails closed for unsupported local ChatGPT Desktop MCP setup", () => {
    const directory = tempDirectory();
    const path = join(directory, "chatgpt.json");
    const result = run(
      ["setup", "chatgpt-desktop", "--config", path],
      { MESHTERM_CONFIG_DIR: join(directory, "mesh-config") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "ChatGPT Desktop cannot load local STDIO MCP servers",
    );
    expect(existsSync(path)).toBe(false);
  });

  test("merges Claude Desktop config without embedding credentials", () => {
    const directory = tempDirectory();
    const path = join(directory, "claude_desktop_config.json");
    const env = { MESHTERM_CONFIG_DIR: join(directory, "mesh-config") };
    const result = run(
      ["setup", "claude-desktop", "--config", path],
      env,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.meshterm.command).toBe(process.execPath);
    expect(parsed.mcpServers.meshterm.args.join(" ")).toContain(
      "packages/mcp/index.ts",
    );
    expect(JSON.stringify(parsed)).not.toContain("mtk_");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("Desktop setup preserves profile-specific MCP entries and environments", () => {
    const directory = tempDirectory();
    const codexPath = join(directory, "config.toml");
    const claudePath = join(directory, "claude.json");
    const env = { MESHTERM_CONFIG_DIR: join(directory, "mesh-config") };
    expect(
      run(
        [
          "setup",
          "codex-desktop",
          "--profile",
          "work",
          "--config",
          codexPath,
        ],
        env,
      ).exitCode,
    ).toBe(0);
    expect(readFileSync(codexPath, "utf8")).toContain(
      'MESHTERM_PROFILE = "work"',
    );
    expect(
      run(
        [
          "setup",
          "claude-desktop",
          "--profile",
          "work",
          "--config",
          claudePath,
        ],
        env,
      ).exitCode,
    ).toBe(0);
    expect(
      JSON.parse(readFileSync(claudePath, "utf8")).mcpServers[
        "meshterm-work"
      ].env.MESHTERM_PROFILE,
    ).toBe("work");
  });
});

describe("credentialless broker mode", () => {
  test("does not load or fall back to a credential profile", () => {
    const directory = tempDirectory();
    const result = run(["status", "--broker-socket", "relative.sock"], {
      MESHTERM_CONFIG_DIR: directory,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "broker socket must be an absolute path",
    );
    expect(result.stderr.toString()).not.toContain("config not found");
  });

  test("rejects a missing broker socket value without direct-mode fallback", () => {
    const directory = tempDirectory();
    const result = run(["status", "--broker-socket"], {
      MESHTERM_CONFIG_DIR: directory,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "usage: meshterm status --broker-socket",
    );
    expect(result.stderr.toString()).not.toContain("config not found");
  });
});

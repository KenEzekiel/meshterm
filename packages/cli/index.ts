#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { randomUUID } from "crypto";
import { requestStatusViaBroker } from "../client/broker";

interface Config {
  server: string;
  credential: string;
}

const raw = process.argv.slice(2);
const command = raw[0] ?? "help";
const configDirectory =
  process.env.MESHTERM_CONFIG_DIR ?? join(homedir(), ".meshterm");

function option(name: string): string | undefined {
  const index = raw.indexOf(`--${name}`);
  return index === -1 ? undefined : raw[index + 1];
}

function flag(name: string): boolean {
  return raw.includes(`--${name}`);
}

function profileName(): string | undefined {
  const profile = option("profile") ?? process.env.MESHTERM_PROFILE;
  if (
    profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)
  ) {
    throw new Error("invalid profile name");
  }
  return profile;
}

function configPath(): string {
  const profile = profileName();
  return profile
    ? join(configDirectory, "profiles", `${profile}.json`)
    : join(configDirectory, "config.json");
}

function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error("config not found; run meshterm init");
  }
  const config = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  if (!config.server || !config.credential) {
    throw new Error("config is invalid; rerun meshterm init with a v1 credential");
  }
  return { server: new URL(config.server).origin, credential: config.credential };
}

async function request(
  path: string,
  config: Config,
  init: RequestInit = {},
): Promise<any> {
  const response = await fetch(`${config.server}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.credential}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Meshterm ${response.status}: ${text.slice(0, 2048)}`);
  }
  return text ? JSON.parse(text) : null;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function desktopCommand(): { command: string; args: string[] } {
  const sourcePath = resolve(import.meta.dir, "../mcp/index.ts");
  const builtPath = resolve(import.meta.dir, "../mcp/index.js");
  return {
    command: process.execPath,
    args: ["run", existsSync(builtPath) ? builtPath : sourcePath],
  };
}

export function installCodexDesktop(
  path = join(homedir(), ".codex", "config.toml"),
): void {
  const invocation = desktopCommand();
  const profile = profileName();
  const serverName =
    option("as") ?? (profile ? `meshterm-${profile}` : "meshterm");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(serverName)) {
    throw new Error("invalid Desktop MCP server name");
  }
  const start = `# BEGIN MESHTERM MANAGED MCP ${serverName}`;
  const end = `# END MESHTERM MANAGED MCP ${serverName}`;
  const environment = [
    `MESHTERM_CONFIG_DIR = ${tomlString(configDirectory)}`,
    ...(profile
      ? [`MESHTERM_PROFILE = ${tomlString(profile)}`]
      : []),
  ].join(", ");
  const block = `${start}
[mcp_servers.${serverName}]
command = ${tomlString(invocation.command)}
args = [${invocation.args.map(tomlString).join(", ")}]
env = { ${environment} }
${end}`;
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const pattern = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}`,
    "g",
  );
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
  writeFileSync(path, next, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function installClaudeDesktop(
  path = join(
    homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  ),
): void {
  const invocation = desktopCommand();
  const profile = profileName();
  const serverName =
    option("as") ?? (profile ? `meshterm-${profile}` : "meshterm");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(serverName)) {
    throw new Error("invalid Desktop MCP server name");
  }
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }
  const servers =
    existing.mcpServers &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  servers[serverName] = {
    command: invocation.command,
    args: invocation.args,
    env: {
      MESHTERM_CONFIG_DIR: configDirectory,
      ...(profile ? { MESHTERM_PROFILE: profile } : {}),
    },
  };
  writeFileSync(
    path,
    `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

export async function runCli(): Promise<void> {
  switch (command) {
    case "init": {
      const server = option("server");
      const credential = process.env.MESHTERM_CREDENTIAL;
      if (!server || !credential) {
        throw new Error(
          "usage: MESHTERM_CREDENTIAL=<mtk_...> meshterm init --server <url> [--profile name]",
        );
      }
      const url = new URL(server);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("server must use HTTP or HTTPS");
      }
      if (!credential.startsWith("mtk_")) {
        throw new Error("credential must be a v1 mtk_ credential");
      }
      saveConfig({ server: url.origin, credential });
      console.log(`saved ${configPath()} with mode 0600`);
      break;
    }
    case "send": {
      const to = raw[1];
      const message = raw[2];
      if (!to || message === undefined) {
        throw new Error(
          "usage: meshterm send <principal-or-channel> <message> [--channel] [--idempotency-key key]",
        );
      }
      const key = option("idempotency-key") ?? randomUUID();
      print(
        await request("/v1/messages", loadConfig(), {
          method: "POST",
          headers: { "idempotency-key": key },
          body: JSON.stringify({
            to: { kind: flag("channel") ? "channel" : "principal", name: to },
            payload: message,
          }),
        }),
      );
      break;
    }
    case "claim":
    case "poll": {
      print(
        await request("/v1/claims", loadConfig(), {
          method: "POST",
          body: JSON.stringify({
            limit: Number(option("limit") ?? 10),
            lease_seconds: Number(option("lease-seconds") ?? 60),
          }),
        }),
      );
      break;
    }
    case "ack": {
      const deliveryId = raw[1];
      const leaseToken = process.env.MESH_LEASE_TOKEN;
      if (!deliveryId || !leaseToken) {
        throw new Error(
          "usage: MESH_LEASE_TOKEN=<mls_...> meshterm ack <delivery-id>",
        );
      }
      print(
        await request(
          `/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`,
          loadConfig(),
          { method: "POST", body: JSON.stringify({ lease_token: leaseToken }) },
        ),
      );
      break;
    }
    case "nack": {
      const deliveryId = raw[1];
      const leaseToken = process.env.MESH_LEASE_TOKEN;
      if (!deliveryId || !leaseToken) {
        throw new Error(
          "usage: MESH_LEASE_TOKEN=<mls_...> meshterm nack <delivery-id> [--retry-after seconds] [--reason code]",
        );
      }
      print(
        await request(
          `/v1/deliveries/${encodeURIComponent(deliveryId)}/nack`,
          loadConfig(),
          {
            method: "POST",
            body: JSON.stringify({
              lease_token: leaseToken,
              ...(option("retry-after")
                ? { retry_after_seconds: Number(option("retry-after")) }
                : {}),
              ...(option("reason") ? { reason_code: option("reason") } : {}),
            }),
          },
        ),
      );
      break;
    }
    case "message":
    case "read": {
      const messageId = raw[1];
      if (!messageId) throw new Error("usage: meshterm message <message-id>");
      print(
        await request(
          `/v1/messages/${encodeURIComponent(messageId)}`,
          loadConfig(),
        ),
      );
      break;
    }
    case "history": {
      const query = new URLSearchParams({
        limit: option("limit") ?? "50",
      });
      if (option("cursor")) query.set("cursor", option("cursor")!);
      print(await request(`/v1/history?${query}`, loadConfig()));
      break;
    }
    case "delete": {
      const messageId = raw[1];
      if (!messageId) throw new Error("usage: meshterm delete <message-id>");
      print(
        await request(
          `/v1/messages/${encodeURIComponent(messageId)}`,
          loadConfig(),
          { method: "DELETE" },
        ),
      );
      break;
    }
    case "status": {
      if (flag("broker-socket") && option("broker-socket") === undefined) {
        throw new Error("usage: meshterm status --broker-socket /absolute/path");
      }
      const brokerSocket =
        option("broker-socket") ?? process.env.MESHTERM_BROKER_SOCKET;
      if (brokerSocket) {
        print({
          broker: "local",
          metrics_scope: "authenticated_principal",
          status: await requestStatusViaBroker(brokerSocket),
        });
        break;
      }
      const config = loadConfig();
      const [ready, metrics] = await Promise.all([
        fetch(`${config.server}/readyz`).then((response) => response.json()),
        request("/v1/metrics", config),
      ]);
      print({ ready, metrics });
      break;
    }
    case "principals": {
      print(await request("/v1/principals", loadConfig()));
      break;
    }
    case "channel": {
      if (raw[1] === "list") {
        print(await request("/v1/channels", loadConfig()));
        break;
      }
      if (raw[1] === "create" && raw[2]) {
        print(
          await request("/v1/channels", loadConfig(), {
            method: "POST",
            body: JSON.stringify({
              name: raw[2],
              members: (option("members") ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            }),
          }),
        );
        break;
      }
      if (raw[1] === "member" && raw[2] === "set" && raw[3] && raw[4]) {
        print(
          await request(
            `/v1/channels/${encodeURIComponent(raw[3])}/members/${encodeURIComponent(raw[4])}`,
            loadConfig(),
            {
              method: "PATCH",
              body: JSON.stringify({ can_send: option("can-send") !== "false" }),
            },
          ),
        );
        break;
      }
      if (raw[1] === "member" && raw[2] === "remove" && raw[3] && raw[4]) {
        print(
          await request(
            `/v1/channels/${encodeURIComponent(raw[3])}/members/${encodeURIComponent(raw[4])}`,
            loadConfig(),
            { method: "DELETE" },
          ),
        );
        break;
      }
      throw new Error(
        "usage: meshterm channel <list|create|member set|member remove>",
      );
    }
    case "admin": {
      const operatorToken = process.env.MESH_OPERATOR_TOKEN ?? "";
      const server = option("server");
      if (!server || operatorToken.length < 32) {
        throw new Error(
          "admin commands require --server and MESH_OPERATOR_TOKEN (32+ characters)",
        );
      }
      const operatorConfig = {
        server: new URL(server).origin,
        credential: operatorToken,
      };
      if (raw[1] === "principal" && raw[2] === "create" && raw[3]) {
        print(
          await request("/v1/operator/principals", operatorConfig, {
            method: "POST",
            body: JSON.stringify({
              name: raw[3],
              kind: option("kind") ?? "agent",
            }),
          }),
        );
        break;
      }
      if (raw[1] === "principal" && raw[2] === "list") {
        print(await request("/v1/operator/principals", operatorConfig));
        break;
      }
      if (raw[1] === "principal" && raw[2] === "revoke" && raw[3]) {
        print(
          await request(
            `/v1/operator/principals/${encodeURIComponent(raw[3])}/revoke`,
            operatorConfig,
            { method: "POST" },
          ),
        );
        break;
      }
      if (raw[1] === "credential" && raw[2] === "issue" && raw[3]) {
        print(
          await request(
            `/v1/operator/principals/${encodeURIComponent(raw[3])}/credentials`,
            operatorConfig,
            { method: "POST" },
          ),
        );
        break;
      }
      if (raw[1] === "credential" && raw[2] === "revoke" && raw[3]) {
        print(
          await request(
            `/v1/operator/credentials/${encodeURIComponent(raw[3])}`,
            operatorConfig,
            { method: "DELETE" },
          ),
        );
        break;
      }
      throw new Error(
        "usage: meshterm admin <principal create/list/revoke|credential issue/revoke> --server <url>",
      );
    }
    case "setup": {
      if (raw[1] === "codex-desktop" || raw[1] === "codex") {
        installCodexDesktop(option("config"));
        console.log(
          "installed the Meshterm MCP adapter for Codex Desktop; restart the app",
        );
        break;
      }
      if (raw[1] === "chatgpt-desktop") {
        throw new Error(
          "ChatGPT Desktop cannot load local STDIO MCP servers; use Codex Desktop locally, or expose a remote MCP endpoint for eligible ChatGPT web workspaces",
        );
      }
      if (raw[1] === "claude-desktop") {
        installClaudeDesktop(option("config"));
        console.log(
          "installed the Meshterm MCP adapter for Claude Desktop; restart the app",
        );
        break;
      }
      throw new Error(
        "usage: meshterm setup <codex-desktop|claude-desktop> [--config path]",
      );
    }
    case "rooms":
    case "room":
    case "roles":
    case "role":
    case "skills":
    case "tasks":
    case "task":
    case "tui":
    case "daemon":
    case "client":
    case "agent":
    case "search":
      throw new Error(
        `${command} was removed from Meshterm core; see docs/MIGRATION_V1.md`,
      );
    case "--version":
    case "version": {
      const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
      ) as { version: string };
      console.log(`meshterm v${pkg.version}`);
      break;
    }
    case "help":
    case "--help":
    default:
      console.log(`meshterm — authenticated durable transport

Core:
  MESHTERM_CREDENTIAL=<mtk_...> meshterm init --server <url>
  send <to> <message> [--channel] [--idempotency-key key]
  claim [--limit n] [--lease-seconds n]
  MESH_LEASE_TOKEN=<mls_...> meshterm ack <delivery-id>
  MESH_LEASE_TOKEN=<mls_...> meshterm nack <delivery-id> [--retry-after n] [--reason code]
  message <message-id>
  history [--limit n] [--cursor value]
  delete <message-id>  # sender only, after all deliveries are terminal
  status [--broker-socket /absolute/path]
  principals
  channel list
  channel create <name> --members a,b
  channel member set <channel> <principal> [--can-send false]
  channel member remove <channel> <principal>

Desktop:
  setup codex-desktop
  setup claude-desktop

Operator:
  admin principal create <name> --server <url>
  admin principal list --server <url>
  admin principal revoke <name> --server <url>
  admin credential issue <principal> --server <url>
  admin credential revoke <credential-id> --server <url>`);
  }
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "command failed");
    process.exit(1);
  });
}

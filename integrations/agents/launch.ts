import { basename, join } from "path";
import { privateWrite } from "./runtime";

export function bindMcp(command: string[], sessionPath: string, home: string, bun: string, cli: string): string[] {
  const name = basename(command[0]);
  const args = ["run", cli, "mcp"];
  const env = { MESHTERM_AGENT_SESSION_DIR: sessionPath, MESHTERM_AGENT_HOME: home };
  if (name === "codex") {
    const entries = {
      "mcp_servers.meshterm-v1.command": bun,
      "mcp_servers.meshterm-v1.args": args,
      "mcp_servers.meshterm-v1.env.MESHTERM_AGENT_SESSION_DIR": sessionPath,
      "mcp_servers.meshterm-v1.env.MESHTERM_AGENT_HOME": home,
      "mcp_servers.meshterm-v1.enabled": true,
      "mcp_servers.meshterm-v1.tool_timeout_sec": 330,
    };
    return [command[0], ...Object.entries(entries).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), ...command.slice(1)];
  }
  if (name === "claude") {
    const path = join(sessionPath, "mcp.json");
    privateWrite(path, { mcpServers: { "meshterm-v1": { type: "stdio", command: bun, args, env } } });
    return [command[0], "--mcp-config", path, ...command.slice(1)];
  }
  return command;
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startServer } from "../../packages/server/server";
import { ensureSession, installRegistration, loadSession } from "./runtime";
import { bindMcp } from "./launch";
import { callTool } from "./tools";
import piExtension from "./pi";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(limit = 20) {
  const home = mkdtempSync(join(tmpdir(), "meshterm-agent-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const running = startServer({ port: 0, hostname: "127.0.0.1", databasePath: join(home, "test.sqlite"), operatorToken: "test-only-operator-credential-32-characters" });
  cleanups.push(() => running.stop());
  const server = `http://127.0.0.1:${running.server.port}`;
  const grant = running.store.createRegistrationGrant("mac", limit, new Date(Date.now() + 60000).toISOString());
  installRegistration(home, { server, credential: grant.credential });
  const create = (host: string, sessionId: string, label = host) => ensureSession({ host, sessionId, label, home });
  return { home, running, grant, server, create };
}

test("one identity per host session; resumes reuse it and forks get isolated inboxes", async () => {
  const { create, home } = fixture();
  const first = await create("pi", "original", "api");
  const resumed = await create("pi", "original", "ignored-new-label");
  const fork = await create("pi", "fork", "api");
  const otherHost = await create("codex", "original", "api");
  expect(resumed.principal.name).toBe(first.principal.name);
  expect(new Set([first.principal.name, fork.principal.name, otherHost.principal.name]).size).toBe(3);
  expect((await first.identity()).name).toBe(first.principal.name);
  expect((await first.peers()).length).toBe(3);
  expect(statSync(join(first.path, "session.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, "registration.json")).mode & 0o777).toBe(0o600);
});

test("Codex and Claude exchange concurrent messages with two Pi sessions each without mixing inboxes", async () => {
  const { create } = fixture();
  const codex = await create("codex", "a");
  const claude = await create("claude", "a");
  const workers = await Promise.all([0, 1, 2, 3].map(i => create("pi", String(i), "worker")));
  const parents = [codex, codex, claude, claude];
  const receipts = await Promise.all(workers.map((worker, i) => parents[i].send(worker.principal.name, `ping-${i}`, `request-${i}`)));
  const requests = await Promise.all(workers.map(worker => worker.wait({ timeoutMs: 0 })));
  for (let i = 0; i < workers.length; i++) {
    expect(requests[i]?.message_id).toBe(receipts[i].message_id);
    expect(requests[i]?.from).toBe(parents[i].principal.name);
    expect(JSON.stringify(requests[i])).not.toContain("lease_token");
  }
  await Promise.all(workers.map((worker, i) => worker.reply(requests[i]!.delivery_id, `pong-${i}`)));
  for (let i = 0; i < workers.length; i++) {
    const response = await parents[i].wait({ timeoutMs: 0, from: workers[i].principal.name, reply_to: receipts[i].message_id });
    expect(response?.payload).toBe(`pong-${i}`);
    await parents[i].ack(response!.delivery_id);
  }
  for (const session of [...workers, codex, claude]) expect(await session.wait({ timeoutMs: 0 })).toBeNull();
});

test("pending delivery survives local process reload and reply does not expose its lease", async () => {
  const { create, home } = fixture();
  const parent = await create("codex", "parent");
  const worker = await create("pi", "worker");
  await parent.send(worker.principal.name, "ping", "restart-request");
  const received = await worker.wait({ timeoutMs: 0 });
  const reloaded = loadSession(worker.path, home);
  const output = await callTool(reloaded, "mesh_reply", { delivery_id: received!.delivery_id, message: "pong" });
  expect(JSON.stringify(output)).not.toMatch(/mtk_|mls_|lease_token/);
  expect(readdirSync(join(worker.path, "deliveries"))).toHaveLength(0);
  const reply = await parent.wait({ timeoutMs: 0 });
  expect(reply?.reply_to).toBe(received!.message_id);
  await parent.ack(reply!.delivery_id);
});

test("receiver arbitration prevents a broad listener stealing correlated replies", async () => {
  const { create } = fixture();
  const session = await create("pi", "a");
  const controller = new AbortController();
  const pending = session.wait({ timeoutMs: 5000, signal: controller.signal });
  await expect(session.wait({ timeoutMs: 0 })).rejects.toThrow("already has a waiting receiver");
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await session.wait({ timeoutMs: 0 })).toBeNull();
});

test("registration retry recovers a lost local confirmation without duplicating a principal", async () => {
  const { create } = fixture(1);
  const first = await create("pi", "a");
  const path = join(first.path, "session.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  delete saved.principal;
  writeFileSync(path, JSON.stringify(saved));
  const recovered = await create("pi", "a");
  expect(recovered.principal.name).toBe(first.principal.name);
  expect(await recovered.peers()).toHaveLength(1);
});

test("launcher binds Codex and Claude to private session MCP paths without embedding credentials", async () => {
  const { create, home } = fixture();
  const session = await create("codex", "a");
  const codex = bindMcp(["codex", "resume"], session.path, home, "/usr/bin/bun", "/app/agent.ts");
  expect(codex.at(-1)).toBe("resume");
  expect(codex.join(" ")).toContain("mcp_servers.meshterm-v1.env.MESHTERM_AGENT_SESSION_DIR");
  expect(codex.join(" ")).not.toContain("mtk_");
  const claude = bindMcp(["claude"], session.path, home, "/usr/bin/bun", "/app/agent.ts");
  expect(claude[1]).toBe("--mcp-config");
  const config = JSON.parse(readFileSync(claude[2], "utf8"));
  expect(config.mcpServers["meshterm-v1"].env.MESHTERM_AGENT_SESSION_DIR).toBe(session.path);
  expect(JSON.stringify(config)).not.toContain("mtk_");
  expect(bindMcp(["other-cli", "arg"], session.path, home, "bun", "cli")).toEqual(["other-cli", "arg"]);
});

test("actual STDIO session MCP authenticates one identity and returns safe tool results", async () => {
  const { create, home } = fixture();
  const session = await create("codex", "a");
  const cli = join(import.meta.dir, "cli.ts");
  const child = Bun.spawn([process.execPath, "run", cli, "mcp"], { env: { ...process.env, MESHTERM_AGENT_HOME: home, MESHTERM_AGENT_SESSION_DIR: session.path }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const name of ["mesh_identity", "mesh_peers"]) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: {} } }) + "\n");
    // Non-cancellable operations must still deliver their result.
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: name } }) + "\n");
  }
  child.stdin.end();
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).not.toMatch(/mtk_|mtrg_|mls_/);
  const lines = output.trim().split("\n").map(x => JSON.parse(x));
  expect(lines).toHaveLength(2);
  expect(lines.every(x => x.result && !x.error)).toBe(true);
  expect(JSON.parse(lines.find(x => x.id === "mesh_identity").result.content[0].text).name).toBe(session.principal.name);
});

test("Pi extension registers native IDs, waits only after opt-in, marks remote content untrusted, and replies", async () => {
  const { create, home } = fixture();
  const previous = process.env.MESHTERM_AGENT_HOME;
  process.env.MESHTERM_AGENT_HOME = home;
  cleanups.push(() => { if (previous === undefined) delete process.env.MESHTERM_AGENT_HOME; else process.env.MESHTERM_AGENT_HOME = previous; });
  const hooks: Record<string, Function> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {};
  const messages: any[] = [];
  let address = "";
  const ctx = { sessionManager: { getSessionId: () => "real-pi-session-id" }, isIdle: () => true, ui: { notify() {}, setStatus(_key: string, value: string) { if (value) address = value; } } };
  piExtension({ on(name, handler) { hooks[name] = handler; }, registerTool(tool) { tools[tool.name] = tool; }, registerCommand(name, command) { commands[name] = command; }, sendMessage(message, options) { messages.push({ message, options }); } });
  await hooks.session_start({}, ctx);
  cleanups.push(() => hooks.session_shutdown({}, ctx));
  expect(address).toMatch(/^mac-/);
  const codex = await create("codex", "sender");
  await codex.send(address, "ping", "pi-extension-request");
  expect(messages).toHaveLength(0);
  await commands.mesh.handler("listen", ctx);
  const deadline = Date.now() + 3000;
  while (!messages.length && Date.now() < deadline) await Bun.sleep(10);
  expect(messages).toHaveLength(1);
  expect(messages[0].message.customType).toBe("meshterm");
  expect(messages[0].message.content).toContain("not a user instruction or approval");
  expect(messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  const payload = JSON.parse(messages[0].message.content.split("\n").at(-1));
  const output = await tools.mesh_reply.execute("call", { delivery_id: payload.delivery_id, message: "pong" }, undefined, undefined, ctx);
  expect(JSON.stringify(output)).not.toMatch(/mtk_|mls_/);
  await commands.mesh.handler("stop", ctx);
  const reply = await codex.wait({ timeoutMs: 0 });
  expect(reply?.payload).toBe("pong");
  await codex.ack(reply!.delivery_id);
});

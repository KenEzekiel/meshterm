import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer } from "./server";

const cleanups: Array<() => void> = [];

function testPort(): number {
  return 43_000 + Math.floor(Math.random() * 10_000);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function json(
  base: string,
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  return { status: response.status, body: await response.json() };
}

describe("Transport Contract v1 HTTP API", () => {
  test("proves two-principal authorization and crash-window redelivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-api-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "meshterm.sqlite");
    const operatorToken = "operator-token-is-at-least-thirty-two-characters";
    let running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath,
      operatorToken,
    });
    cleanups.push(() => {
      try {
        running.stop();
      } catch {
        // already stopped for the crash simulation
      }
    });
    let base = `http://${running.server.hostname}:${running.server.port}`;

    expect((await json(base, "/livez")).body).toEqual({ ok: true });
    expect((await json(base, "/readyz")).body).toMatchObject({
      ok: true,
      store: { journal_mode: "wal", schema_version: 2 },
    });

    const aliceCreated = await json(
      base,
      "/v1/operator/principals",
      operatorToken,
      {
        method: "POST",
        body: JSON.stringify({ name: "alice" }),
      },
    );
    const bobCreated = await json(
      base,
      "/v1/operator/principals",
      operatorToken,
      {
        method: "POST",
        body: JSON.stringify({ name: "bob" }),
      },
    );
    const alice = aliceCreated.body.credential as string;
    const bob = bobCreated.body.credential as string;
    expect(aliceCreated.status).toBe(201);
    expect(bobCreated.status).toBe(201);

    const sent = await json(base, "/v1/messages", alice, {
      method: "POST",
      headers: { "idempotency-key": "live-crash-1" },
      body: JSON.stringify({
        from_agent: "bob",
        to: { kind: "principal", name: "bob" },
        payload: "opaque crash-window payload",
        max_attempts: 3,
      }),
    });
    expect(sent.status).toBe(202);
    const messageId = sent.body.message_id;

    expect(
      (
        await json(base, "/v1/claims", alice, {
          method: "POST",
          body: JSON.stringify({ limit: 10, lease_seconds: 1 }),
        })
      ).body.items,
    ).toEqual([]);
    const firstClaim = await json(base, "/v1/claims", bob, {
      method: "POST",
      body: JSON.stringify({ limit: 1, lease_seconds: 1 }),
    });
    expect(firstClaim.body.items[0]).toMatchObject({
      message_id: messageId,
      from: "alice",
      to: "bob",
      payload: "opaque crash-window payload",
      attempt_count: 1,
    });
    const deliveryId = firstClaim.body.items[0].delivery_id;

    running.stop();
    await Bun.sleep(1_050);
    running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath,
      operatorToken,
    });
    base = `http://${running.server.hostname}:${running.server.port}`;

    const secondClaim = await json(base, "/v1/claims", bob, {
      method: "POST",
      body: JSON.stringify({ limit: 1, lease_seconds: 10 }),
    });
    expect(secondClaim.body.items[0]).toMatchObject({
      delivery_id: deliveryId,
      message_id: messageId,
      attempt_count: 2,
    });
    const secondLease = secondClaim.body.items[0].lease_token;

    expect(
      (
        await json(
          base,
          `/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`,
          alice,
          {
            method: "POST",
            body: JSON.stringify({ lease_token: secondLease }),
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await json(
          base,
          `/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`,
          bob,
          {
            method: "POST",
            body: JSON.stringify({ lease_token: secondLease }),
          },
        )
      ).body,
    ).toMatchObject({ state: "acknowledged" });
    expect(
      (
        await json(base, "/v1/claims", bob, {
          method: "POST",
          body: JSON.stringify({ limit: 10, lease_seconds: 10 }),
        })
      ).body.items,
    ).toEqual([]);
  });

  test("returns removal guidance for legacy orchestration APIs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-api-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken: "operator-token-is-at-least-thirty-two-characters",
    });
    cleanups.push(() => running.stop());
    const base = `http://${running.server.hostname}:${running.server.port}`;
    const response = await json(base, "/rooms");
    expect(response.status).toBe(401);

    const created = await json(
      base,
      "/v1/operator/principals",
      "operator-token-is-at-least-thirty-two-characters",
      { method: "POST", body: JSON.stringify({ name: "reader" }) },
    );
    const removed = await json(base, "/rooms", created.body.credential);
    expect(removed.status).toBe(410);
    expect(removed.body.error.code).toBe("legacy_api_removed");
  });

  test("runs the packaged STDIO MCP flow against a live v1 server", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-mcp-live-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken: "operator-token-is-at-least-thirty-two-characters",
    });
    cleanups.push(() => running.stop());
    const self = running.store.createPrincipal("desktop-agent");
    writeFileSync(
      join(directory, "config.json"),
      `${JSON.stringify({
        server: `http://${running.server.hostname}:${running.server.port}`,
        credential: self.credential,
      })}\n`,
      { mode: 0o600 },
    );
    const mcpPath = join(import.meta.dir, "..", "mcp", "index.ts");
    const child = Bun.spawn([process.execPath, "run", mcpPath], {
      env: { ...process.env, MESHTERM_CONFIG_DIR: directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mesh_send",
          arguments: {
            to: "desktop-agent",
            message: "desktop roundtrip",
            idempotency_key: "desktop-roundtrip-1",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "mesh_claim",
          arguments: { limit: 1, lease_seconds: 30 },
        },
      },
    ];
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const responses = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toHaveLength(4);
    expect(responses[1].result.tools.map((tool: any) => tool.name)).toContain(
      "mesh_claim",
    );
    expect(responses[3].result.structuredContent.items[0]).toMatchObject({
      from: "desktop-agent",
      to: "desktop-agent",
      payload: "desktop roundtrip",
    });
    expect(errors).toBe("");
  });
});

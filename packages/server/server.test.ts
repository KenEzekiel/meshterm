import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MeshtermClient } from "../client";
import { startServer } from "./server";

const cleanups: Array<() => void> = [];

function testPort(): number {
  return 0;
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
      store: { journal_mode: "wal", schema_version: 3 },
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

  test("matches a principal reply without consuming unrelated queued work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-api-matching-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken: "operator-token-is-at-least-thirty-two-characters",
    });
    cleanups.push(() => running.stop());
    const alice = running.store.createPrincipal("alice");
    const bob = running.store.createPrincipal("bob");
    const mallory = running.store.createPrincipal("mallory");
    const aliceActor = running.store.authenticate(alice.credential);
    if (!aliceActor) throw new Error("alice authentication failed");
    running.store.createChannel(aliceActor, "matching-requests", ["bob", "mallory"]);
    const parent = running.store.send(
      aliceActor,
      "http-parent-1",
      { to: { kind: "channel", name: "matching-requests" }, payload: "request" },
    );
    const bobActor = running.store.authenticate(bob.credential);
    const malloryActor = running.store.authenticate(mallory.credential);
    if (!bobActor || !malloryActor) throw new Error("reply principal authentication failed");
    const reply = running.store.send(
      bobActor,
      "http-reply-1",
      {
        to: { kind: "principal", name: "alice" },
        payload: "reply",
        reply_to: parent.message_id,
      },
    );
    running.store.send(
      bobActor,
      "http-unrelated-1",
      { to: { kind: "principal", name: "alice" }, payload: "unrelated" },
    );
    running.store.send(
      malloryActor,
      "http-wrong-sender-1",
      {
        to: { kind: "principal", name: "alice" },
        payload: "wrong sender",
        reply_to: parent.message_id,
      },
    );
    const base = `http://${running.server.hostname}:${running.server.port}`;
    const matching = await json(base, "/v1/claims/matching", alice.credential, {
      method: "POST",
      body: JSON.stringify({
        limit: 1,
        lease_seconds: 30,
        reply_to: parent.message_id,
        from: "bob",
      }),
    });
    expect(matching.status).toBe(200);
    expect(matching.body.items).toHaveLength(1);
    expect(matching.body.items[0]).toMatchObject({
      message_id: reply.message_id,
      from: "bob",
      payload: "reply",
    });
    expect(running.store.metrics(aliceActor).active_leases).toBe(1);
    const remaining = await json(base, "/v1/claims", alice.credential, {
      method: "POST",
      body: JSON.stringify({ limit: 10, lease_seconds: 30 }),
    });
    expect(
      remaining.body.items.map((item: any) => item.payload).sort(),
    ).toEqual(["unrelated", "wrong sender"]);
  });

  test("completes a real principal request/reply without acknowledging either delivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-api-request-reply-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken: "operator-token-is-at-least-thirty-two-characters",
    });
    cleanups.push(() => running.stop());
    const alice = running.store.createPrincipal("alice");
    const bob = running.store.createPrincipal("bob");
    const base = `http://${running.server.hostname}:${running.server.port}`;
    const requester = new MeshtermClient({
      server: base,
      credential: alice.credential,
    });
    const responder = new MeshtermClient({
      server: base,
      credential: bob.credential,
    });
    const unrelated = await responder.send("real-unrelated-1", {
      to: { kind: "principal", name: "alice" },
      payload: "unrelated",
    });
    const responderWait = responder.waitForDelivery({
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      maxPollIntervalMs: 4,
    });
    const request = requester.sendAndWait(
      "real-request-1",
      { to: { kind: "principal", name: "bob" }, payload: "request" },
      { timeoutMs: 1_000, pollIntervalMs: 1, maxPollIntervalMs: 4 },
    );
    const incoming = await responderWait;
    expect(incoming).toMatchObject({ payload: "request", from: "alice" });
    await responder.send("real-reply-1", {
      to: { kind: "principal", name: "alice" },
      payload: "reply",
      reply_to: incoming!.message_id,
    });
    const result = await request;
    expect(result.reply).toMatchObject({
      payload: "reply",
      from: "bob",
      reply_to: result.receipt.message_id,
    });
    const unrelatedState = running.store.db
      .query("SELECT state,attempt_count FROM deliveries WHERE message_id=?")
      .get(unrelated.message_id) as { state: string; attempt_count: number };
    expect(unrelatedState).toEqual({ state: "queued", attempt_count: 0 });
    const requestState = running.store.db
      .query("SELECT state,attempt_count FROM deliveries WHERE message_id=?")
      .get(result.receipt.message_id) as { state: string; attempt_count: number };
    expect(requestState).toEqual({ state: "leased", attempt_count: 1 });
    const replyState = running.store.db
      .query("SELECT state,attempt_count FROM deliveries WHERE message_id=?")
      .get(result.reply!.message_id) as { state: string; attempt_count: number };
    expect(replyState).toEqual({ state: "leased", attempt_count: 1 });
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
    const selfActor = running.store.authenticate(self.credential);
    if (!selfActor) throw new Error("desktop principal authentication failed");
    running.store.send(
      selfActor,
      "desktop-preloaded-1",
      {
        to: { kind: "principal", name: "desktop-agent" },
        payload: "preloaded desktop message",
      },
    );
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
      payload: "preloaded desktop message",
    });
    expect(errors).toBe("");
  });

  test("cancels an outstanding MCP wait while another request completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-mcp-cancel-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken: "operator-token-is-at-least-thirty-two-characters",
    });
    cleanups.push(() => running.stop());
    const self = running.store.createPrincipal("cancel-agent");
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
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "waiting",
        method: "tools/call",
        params: {
          name: "mesh_wait",
          arguments: {
            timeout_ms: 30_000,
            poll_interval_ms: 5,
            max_poll_interval_ms: 10,
          },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "status",
        method: "tools/call",
        params: { name: "mesh_status", arguments: {} },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "waiting", reason: "test cancellation" },
      })}\n`,
    );
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const responses = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(responses.map((response: any) => response.id)).toEqual(["status"]);
    expect(responses[0].result.structuredContent).toHaveProperty("ready");
    expect(errors).toBe("");
  });

  test("enforces registration grant scope and renews only the recipient lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "meshterm-registration-api-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const operatorToken = "operator-token-is-at-least-thirty-two-characters";
    const running = startServer({
      port: testPort(),
      hostname: "127.0.0.1",
      databasePath: join(directory, "meshterm.sqlite"),
      operatorToken,
    });
    cleanups.push(() => running.stop());
    const base = `http://${running.server.hostname}:${running.server.port}`;
    const grantResponse = await json(
      base,
      "/v1/operator/registration-grants",
      operatorToken,
      {
        method: "POST",
        body: JSON.stringify({
          namespace: "sessions",
          max_principals: 2,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    );
    expect(grantResponse.status).toBe(201);
    expect(Object.keys(grantResponse.body).sort()).toEqual([
      "credential",
      "grant_id",
    ]);
    const grantCredential = grantResponse.body.credential as string;
    const registrationCredential =
      `mtk_00000000-0000-0000-0000-000000000002.${"a".repeat(64)}`;
    const registration = await json(base, "/v1/registrations", grantCredential, {
      method: "POST",
      body: JSON.stringify({
        registration_key: "00000000-0000-0000-0000-000000000001",
        label: "session",
        credential: registrationCredential,
      }),
    });
    expect(registration.status).toBe(201);
    expect(registration.body).toMatchObject({
      duplicate: false,
      principal: { name: "sessions-session-7ac1b8d7010b", kind: "agent" },
    });
    expect(
      (await json(base, "/v1/registrations", grantCredential)).body,
    ).toEqual({ principals: [registration.body.principal] });
    expect(
      (await json(base, "/v1/messages", grantCredential, {
        method: "POST",
        headers: { "idempotency-key": "grant-scope" },
        body: JSON.stringify({
          to: { kind: "principal", name: registration.body.principal.name },
          payload: "must be denied",
        }),
      })).status,
    ).toBe(403);
    expect(
      (await json(base, "/v1/registrations", registrationCredential)).status,
    ).toBe(403);
    expect(
      (await json(base, "/v1/me", registrationCredential)).body,
    ).toEqual({ principal: registration.body.principal });

    const sender = await json(base, "/v1/operator/principals", operatorToken, {
      method: "POST",
      body: JSON.stringify({ name: "sender" }),
    });
    const sent = await json(base, "/v1/messages", sender.body.credential, {
      method: "POST",
      headers: { "idempotency-key": "renew-api-1" },
      body: JSON.stringify({
        to: { kind: "principal", name: registration.body.principal.name },
        payload: "lease me",
      }),
    });
    expect(sent.status).toBe(202);
    const claim = await json(base, "/v1/claims", registrationCredential, {
      method: "POST",
      body: JSON.stringify({ limit: 1, lease_seconds: 60 }),
    });
    expect(claim.status).toBe(200);
    const delivery = claim.body.items[0];
    const renewed = await json(
      base,
      `/v1/deliveries/${encodeURIComponent(delivery.delivery_id)}/renew`,
      registrationCredential,
      {
        method: "POST",
        body: JSON.stringify({ lease_token: delivery.lease_token, lease_seconds: 120 }),
      },
    );
    expect(renewed.status).toBe(200);
    expect(Date.parse(renewed.body.lease_expires_at)).toBeGreaterThan(
      Date.parse(delivery.lease_expires_at),
    );
    expect(
      (
        await json(
          base,
          `/v1/deliveries/${encodeURIComponent(delivery.delivery_id)}/renew`,
          sender.body.credential,
          {
            method: "POST",
            body: JSON.stringify({
              lease_token: delivery.lease_token,
              lease_seconds: 120,
            }),
          },
        )
      ).status,
    ).toBe(404);
  });
});

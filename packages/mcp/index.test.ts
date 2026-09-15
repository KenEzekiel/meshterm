import { describe, expect, test } from "bun:test";
import { callTool, handleRequest, TOOLS, type Config } from "./index";

const config: Config = {
  server: "https://mesh.example.test",
  credential: "mtk_test",
};

function mockFetch(
  handler: (url: string, init: RequestInit) => unknown,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const value = handler(String(input), init);
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("MCP contract", () => {
  test("advertises only the reduced explicit delivery tool surface", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "mesh_send",
      "mesh_wait",
      "mesh_send_and_wait",
      "mesh_claim",
      "mesh_poll",
      "mesh_ack",
      "mesh_nack",
      "mesh_message",
      "mesh_status",
    ]);
    expect(JSON.stringify(TOOLS)).not.toContain("room");
    expect(JSON.stringify(TOOLS)).not.toContain("role");
    expect(JSON.stringify(TOOLS)).not.toContain("skill");
  });

  test("initialize contains static trust guidance but no remote content", async () => {
    const response = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      config,
    );
    expect(response?.result).toMatchObject({
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "meshterm" },
    });
    expect(JSON.stringify(response)).toContain("untrusted data");
  });

  test("claim never acknowledges and returns full structured deliveries", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const delivery = {
      delivery_id: "delivery-1",
      message_id: "message-1",
      from: "alice",
      to: "bob",
      payload: "full opaque payload",
      lease_token: "mls_secret",
    };
    const result = await callTool(
      "mesh_claim",
      { limit: 1, lease_seconds: 30 },
      config,
      mockFetch((url, init) => {
        requests.push({ url, method: init.method ?? "GET" });
        return { items: [delivery] };
      }),
    );
    expect(requests).toEqual([
      { url: "https://mesh.example.test/v1/claims", method: "POST" },
    ]);
    expect(result).toMatchObject({
      structuredContent: { items: [delivery] },
    });
  });

  test("ack is explicit and sends the lease token in the JSON body", async () => {
    let body = "";
    await callTool(
      "mesh_ack",
      { delivery_id: "delivery-1", lease_token: "mls_secret" },
      config,
      mockFetch((url, init) => {
        expect(url).toEndWith("/v1/deliveries/delivery-1/ack");
        body = String(init.body);
        return { state: "acknowledged" };
      }),
    );
    expect(JSON.parse(body)).toEqual({ lease_token: "mls_secret" });
  });

  test("send derives the sender at the server and supplies idempotency", async () => {
    let requestBody: Record<string, unknown> = {};
    let headers: RequestInit["headers"];
    await callTool(
      "mesh_send",
      {
        to: "bob",
        message: "hello",
        idempotency_key: "event-1",
      },
      config,
      mockFetch((_url, init) => {
        requestBody = JSON.parse(String(init.body));
        headers = init.headers;
        return { message_id: "message-1", duplicate: false };
      }),
    );
    expect(requestBody).toEqual({
      to: { kind: "principal", name: "bob" },
      payload: "hello",
    });
    expect(JSON.stringify(requestBody)).not.toContain("from");
    expect(headers).toMatchObject({ "idempotency-key": "event-1" });
  });

  test("send forwards reply_to while keeping sender authentication implicit", async () => {
    let requestBody: Record<string, unknown> = {};
    await callTool(
      "mesh_send",
      {
        to: "bob",
        message: "reply",
        reply_to: "parent-1",
        idempotency_key: "event-reply-1",
      },
      config,
      mockFetch((_url, init) => {
        requestBody = JSON.parse(String(init.body));
        return { message_id: "reply-1" };
      }),
    );
    expect(requestBody).toMatchObject({
      to: { kind: "principal", name: "bob" },
      payload: "reply",
      reply_to: "parent-1",
    });
    expect(requestBody).not.toHaveProperty("from");
  });

  test("mesh_wait polls and leaves the delivery unacknowledged", async () => {
    const requests: string[] = [];
    const delivery = {
      delivery_id: "delivery-1",
      message_id: "message-1",
      from: "alice",
      to: "bob",
      payload: "reply",
      content_type: "text/plain",
      attributes: null,
      reply_to: null,
      created_at: "2026-09-15T00:00:00.000Z",
      attempt_count: 1,
      lease_token: "mls_secret",
      lease_expires_at: "2026-09-15T00:01:00.000Z",
    };
    let calls = 0;
    const result = await callTool(
      "mesh_wait",
      { timeout_ms: 100, poll_interval_ms: 1, max_poll_interval_ms: 2 },
      config,
      mockFetch((url) => {
        requests.push(new URL(url).pathname);
        calls += 1;
        return calls === 1 ? { items: [] } : { items: [delivery] };
      }),
    );
    expect((result as any).structuredContent).toEqual(delivery);
    expect(requests).toEqual(["/v1/claims", "/v1/claims"]);
    expect(requests.some((path) => path.includes("ack"))).toBe(false);
  });

  test("mesh_send_and_wait returns the receipt and correlated reply", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const receipt = {
      message_id: "parent-1",
      delivery_ids: ["parent-delivery"],
      duplicate: false,
      created_at: "2026-09-15T00:00:00.000Z",
    };
    const reply = { delivery_id: "reply-delivery", message_id: "reply-1" };
    let call = 0;
    const result = await callTool(
      "mesh_send_and_wait",
      {
        to: "worker",
        message: "request",
        idempotency_key: "request-1",
        timeout_ms: 100,
        reply_to: "older-parent",
      },
      config,
      mockFetch((url, init) => {
        call += 1;
        requests.push({
          path: new URL(url).pathname,
          body: init.body ? JSON.parse(String(init.body)) : {},
        });
        return call === 1 ? receipt : { items: [reply] };
      }),
    );
    expect((result as any).structuredContent).toEqual({ receipt, reply });
    expect(requests).toEqual([
      {
        path: "/v1/messages",
        body: {
          to: { kind: "principal", name: "worker" },
          payload: "request",
          reply_to: "older-parent",
        },
      },
      {
        path: "/v1/claims/matching",
        body: {
          limit: 1,
          lease_seconds: 60,
          reply_to: "parent-1",
          from: "worker",
        },
      },
    ]);
  });

  test("retains an accepted send receipt when waiting fails", async () => {
    let calls = 0;
    const receipt = {
      message_id: "accepted-parent",
      delivery_ids: ["delivery-1"],
      duplicate: false,
      created_at: "2026-09-15T00:00:00.000Z",
    };
    const response = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "mesh_send_and_wait",
          arguments: {
            to: "worker",
            message: "request",
            idempotency_key: "request-failure-1",
            timeout_ms: 0,
          },
        },
      },
      config,
      (async (input: string | URL | Request) => {
        calls += 1;
        const path = new URL(String(input)).pathname;
        return new Response(
          JSON.stringify(calls === 1 ? receipt : { error: "legacy server" }),
          { status: calls === 1 ? 202 : 404 },
        );
      }) as unknown as typeof fetch,
    );
    expect(response).toMatchObject({
      error: {
        code: -32603,
        data: { receipt: { message_id: "accepted-parent" } },
      },
    });
  });

  test("cancellation aborts a pending MCP wait", async () => {
    const caller = new AbortController();
    const pending = callTool(
      "mesh_wait",
      { timeout_ms: 100, poll_interval_ms: 1 },
      config,
      (async (_input: string | URL | Request, init: RequestInit = {}) => {
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
      caller.signal,
    );
    await Bun.sleep(1);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("sanitizes tool failures instead of returning stack traces", async () => {
    const response = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "mesh_message",
          arguments: { message_id: "missing" },
        },
      },
      config,
      (async () => {
        throw new Error("credential=secret internal stack");
      }) as unknown as typeof fetch,
    );
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "Meshterm tool call failed" },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});

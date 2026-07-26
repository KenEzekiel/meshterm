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

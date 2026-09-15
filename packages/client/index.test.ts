import { describe, expect, test } from "bun:test";
import {
  MeshtermClient,
  MeshtermClientError,
  type ClaimedDelivery,
} from "./index";

function mockFetch(
  status: number,
  body: unknown,
  inspect?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    inspect?.(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("generic downstream transport client", () => {
  test("sends an opaque envelope with a caller-owned idempotency key", async () => {
    let captured: any;
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: mockFetch(202, { message_id: "m1" }, (_url, init) => {
        captured = {
          headers: init.headers,
          body: JSON.parse(String(init.body)),
        };
      }),
    });
    expect(
      await client.send("delegation-event-id", {
        to: { kind: "principal", name: "worker" },
        payload: "{\"consumer\":\"owns-this-schema\"}",
        attributes: { opaque: true },
      }),
    ).toEqual({ message_id: "m1" });
    expect(captured.headers).toMatchObject({
      "idempotency-key": "delegation-event-id",
    });
    expect(captured.body).not.toHaveProperty("from_agent");
  });

  test("claim and ack remain separate calls", async () => {
    const paths: string[] = [];
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: mockFetch(200, { items: [] }, (url) => paths.push(url)),
    });
    await client.claim(10, 60);
    expect(paths).toEqual(["https://mesh.example.test/v1/claims"]);
  });

  test("surfaces bounded HTTP failures without leaking the credential", async () => {
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_do-not-leak",
      fetch: mockFetch(403, { error: "forbidden" }),
    });
    let failure: unknown;
    try {
      await client.metrics();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MeshtermClientError);
    expect(String(failure)).not.toContain("do-not-leak");
  });

  test("waits by polling without acknowledging the claimed delivery", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const delivery: ClaimedDelivery = {
      delivery_id: "d1",
      message_id: "m1",
      from: "alice",
      to: "bob",
      payload: "reply",
      content_type: "text/plain",
      attributes: null,
      reply_to: null,
      created_at: "2026-09-15T00:00:00.000Z",
      attempt_count: 1,
      lease_token: "mls_reply",
      lease_expires_at: "2026-09-15T00:01:00.000Z",
    };
    let polls = 0;
    const fetchWithReply = (async (input: string | URL | Request, init: RequestInit = {}) => {
      polls += 1;
      const body = polls === 1 ? { items: [] } : { items: [delivery] };
      requests.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const waited = await new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: fetchWithReply,
    }).waitForDelivery({ timeoutMs: 100, pollIntervalMs: 1, maxPollIntervalMs: 2 });
    expect(waited).toEqual(delivery);
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/claims",
      "/v1/claims",
    ]);
    expect(requests.some((request) => request.path.includes("/ack"))).toBe(false);
  });

  test("uses a dedicated matching claim with both correlation filters", async () => {
    let path = "";
    let body: Record<string, unknown> | undefined;
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: mockFetch(200, { items: [] }, (url, init) => {
        path = new URL(url).pathname;
        body = JSON.parse(String(init.body));
      }),
    });
    expect(
      await client.waitForDelivery({
        reply_to: "parent-1",
        from: "alice",
        timeoutMs: 0,
      }),
    ).toBeNull();
    expect(path).toBe("/v1/claims/matching");
    expect(body).toMatchObject({
      limit: 1,
      lease_seconds: 60,
      reply_to: "parent-1",
      from: "alice",
    });
  });

  test("fails closed when an older server lacks matching claims", async () => {
    const paths: string[] = [];
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return new Response(
          JSON.stringify(path === "/v1/claims/matching" ? { error: "not found" } : { items: [] }),
          { status: path === "/v1/claims/matching" ? 404 : 200 },
        );
      }) as unknown as typeof fetch,
    });
    await expect(
      client.waitForDelivery({
        reply_to: "parent-1",
        from: "alice",
        timeoutMs: 10,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(MeshtermClientError);
    expect(paths).toEqual(["/v1/claims/matching"]);
  });

  test("returns a receipt with a null reply when send-and-wait times out", async () => {
    const paths: string[] = [];
    const receipt = {
      message_id: "parent-1",
      delivery_ids: ["parent-delivery"],
      duplicate: false,
      created_at: "2026-09-15T00:00:00.000Z",
    };
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: mockFetch(200, receipt, (url) => paths.push(new URL(url).pathname)),
    });
    const result = await client.sendAndWait(
      "request-1",
      { to: { kind: "principal", name: "worker" }, payload: "request" },
      { timeoutMs: 0 },
    );
    expect(result).toEqual({ receipt, reply: null });
    expect(paths).toEqual(["/v1/messages", "/v1/claims/matching"]);
  });

  test("validates send-and-wait options and target before sending", async () => {
    let sends = 0;
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      fetch: mockFetch(200, {}, (url) => {
        if (new URL(url).pathname === "/v1/messages") sends += 1;
      }),
    });
    await expect(
      client.sendAndWait(
        "request-1",
        { to: { kind: "channel", name: "workers" }, payload: "request" },
        { timeoutMs: -1 },
      ),
    ).rejects.toThrow("timeoutMs");
    expect(sends).toBe(0);
    await expect(
      client.sendAndWait("request-2", {
        to: { kind: "channel", name: "workers" },
        payload: "request",
      }),
    ).rejects.toThrow("principal target");
    expect(sends).toBe(0);
  });

  test("combines caller cancellation with the request timeout", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const never = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      requestSignal = init.signal ?? undefined;
      await new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const client = new MeshtermClient({
      server: "https://mesh.example.test",
      credential: "mtk_test",
      timeoutMs: 10,
      fetch: never,
    });
    const pending = client.waitForDelivery({
      timeoutMs: 100,
      pollIntervalMs: 1,
      signal: caller.signal,
    });
    await Bun.sleep(1);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
  });
});

test("wait deadline does not discard a claim already accepted by the server", async () => {
  const item = { delivery_id: "d-delayed", message_id: "m-delayed" };
  let calls = 0;
  const client = new MeshtermClient({
    server: "https://mesh.example.test", credential: "mtk_test", timeoutMs: 200,
    fetch: (async (_url, init) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ items: [item] }))), 40);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    }) as typeof fetch,
  });
  expect(await client.waitForDelivery({ timeoutMs: 10 })).toMatchObject(item);
  expect(calls).toBe(1);
});

test("an uncertain claim timeout stops instead of repeatedly consuming delivery attempts", async () => {
  let calls = 0;
  const client = new MeshtermClient({
    server: "https://mesh.example.test", credential: "mtk_test", timeoutMs: 10,
    fetch: (async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch,
  });
  await expect(client.waitForDelivery({ timeoutMs: 100 })).rejects.toMatchObject({ name: "MeshtermClaimTimeoutError" });
  expect(calls).toBe(1);
});

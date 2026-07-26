import { describe, expect, test } from "bun:test";
import { MeshtermClient, MeshtermClientError } from "./index";

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
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { startServer } from "./server";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const lines: string[] = [];
  const output = spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  cleanups.push(() => output.mockRestore());
  const running = startServer({
    port: 0,
    hostname: "127.0.0.1",
    databasePath: ":memory:",
    operatorToken: "synthetic-operator-token-for-local-http-tests",
  });
  cleanups.push(() => running.stop());
  return {
    base: `http://127.0.0.1:${running.server.port}`,
    store: running.store,
    records: (): unknown[] => lines.flatMap((line) => {
      const record: unknown = JSON.parse(line);
      return typeof record === "object" && record !== null &&
        "schema" in record && record.schema === "personal.observability.v1"
        ? [record] : [];
    }),
  };
}

test("health responses correlate with one collector-safe summary", async () => {
  const { base, records } = fixture();
  const response = await fetch(`${base}/health?token=PRIVATE_QUERY`, {
    headers: {
      "x-request-id": "PRIVATE_CALLER_ID",
      authorization: "Bearer PRIVATE_CREDENTIAL",
      cookie: "session=PRIVATE_COOKIE",
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const entries = records();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toEqual({
    schema: "personal.observability.v1",
    event: "http.request",
    route: "/health",
    method: "GET",
    status: 200,
    durationMs: expect.any(Number),
    requestId: response.headers.get("x-request-id"),
    errorType: "none",
  });
  expect(response.headers.get("x-request-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const entry = entries[0];
  if (typeof entry !== "object" || entry === null || !("durationMs" in entry) ||
    typeof entry.durationMs !== "number") {
    throw new Error("Expected a numeric HTTP duration");
  }
  expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(entries)).not.toContain("PRIVATE");
});

test("denied transport requests and unknown paths never log opaque input", async () => {
  const { base, records } = fixture();
  for (const [path, route] of [
    ["/v1/messages/PRIVATE_MESSAGE_ID?key=PRIVATE_QUERY", "/v1/*"],
    ["/PRIVATE_PATH?key=PRIVATE_QUERY", "unmatched"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer PRIVATE_CREDENTIAL",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "PRIVATE_PAYLOAD", attributes: { private: "PRIVATE_ATTRIBUTE" } }),
    });
    expect(response.status).toBe(401);
    await response.text();
    const entry = records().at(-1);
    expect(entry).toMatchObject({
      event: "http.request", route, method: "POST", status: 401,
      requestId: response.headers.get("x-request-id"),
    });
  }
  expect(records()).toHaveLength(2);
  expect(JSON.stringify(records())).not.toContain("PRIVATE");
});

test("a real store failure keeps the generic response and a correlated safe summary", async () => {
  const { base, store, records } = fixture();
  store.close();
  const response = await fetch(`${base}/readyz`);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: { code: "internal_error", message: "internal server error" },
  });
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({
    route: "/readyz", status: 500, errorType: "ServerError",
    requestId: response.headers.get("x-request-id"),
  });
  expect(JSON.stringify(records())).not.toContain("closed");
});

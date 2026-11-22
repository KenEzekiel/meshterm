import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer } from "./server";

const cleanups: Array<() => void> = [];
const operatorToken = "synthetic-operator-token-with-at-least-32-characters";
const metricsToken = "synthetic-metrics-token-with-at-least-32-characters";
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(token: string) {
  const directory = mkdtempSync(join(tmpdir(), "meshterm-metrics-"));
  const running = startServer({ port: 0, hostname: "127.0.0.1", databasePath: join(directory, "fixture.sqlite"), operatorToken, metricsToken: token });
  cleanups.push(() => { running.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { ...running, base: `http://127.0.0.1:${running.server.port}` };
}

test("disabled metrics and invalid credentials never expose aggregates", async () => {
  for (const token of ["", "short"]) {
    const { base } = fixture(token);
    const response = await fetch(base + "/internal/metrics", { headers: { authorization: `Bearer ${operatorToken}` } });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("meshterm_queue_depth");
  }
  const { base } = fixture(metricsToken);
  for (const token of ["", operatorToken, "wrong", "x".repeat(metricsToken.length), "é".repeat(metricsToken.length)]) {
    expect((await fetch(base + "/internal/metrics", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  }
  expect((await fetch(base + "/internal/metrics", { method: "POST", headers: { authorization: `Bearer ${metricsToken}` } })).status).toBe(404);
});

test("scrapes only aggregate gauges without disclosing or changing deliveries", async () => {
  const { base, store } = fixture(metricsToken);
  const sender = store.createPrincipal("private-sender");
  store.createPrincipal("private-recipient");
  const actor = store.authenticate(sender.credential);
  if (!actor) throw new Error("No fixture principal");
  const sent = store.send(actor, "private-idempotency", { to: { kind: "principal", name: "private-recipient" }, payload: "private-payload", attributes: { value: "private-attribute" } });
  const now = Date.now();
  const before = store.metrics(undefined, now);
  const beforeMessage = store.getMessage(actor, sent.message_id);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/internal/metrics?private-query=1", { headers: { authorization: `Bearer ${metricsToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const text = await response.text();
    expect(text).toContain("# TYPE meshterm_queue_depth gauge\nmeshterm_queue_depth 1\n");
    expect(text).toContain("meshterm_acknowledged_deliveries 0\n");
    expect(text).toContain("meshterm_oldest_queued_delivery_age_seconds ");
    expect(text.match(/^# TYPE /gm)).toHaveLength(8);
    expect(text).not.toContain("{");
    expect(text).not.toContain("private-");
    expect(text).not.toContain(sender.credential);
    expect(text).not.toContain(metricsToken);
  }
  expect(store.metrics(undefined, now)).toEqual(before);
  expect(store.getMessage(actor, sent.message_id)).toEqual(beforeMessage);
  expect((await fetch(base + "/v1/operator/metrics", { headers: { authorization: `Bearer ${metricsToken}` } })).status).toBe(401);
});

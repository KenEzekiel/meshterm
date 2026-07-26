import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TransportError,
  TransportStore,
  type AuthenticatedPrincipal,
} from "./transport";

const tempDirectories: string[] = [];

function createStore(name = "transport.sqlite"): {
  store: TransportStore;
  path: string;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "meshterm-v1-"));
  tempDirectories.push(directory);
  const path = join(directory, name);
  return { store: new TransportStore(path), path, directory };
}

function principal(
  store: TransportStore,
  name: string,
): { actor: AuthenticatedPrincipal; credential: string } {
  const created = store.createPrincipal(name);
  const actor = store.authenticate(created.credential);
  if (!actor) throw new Error("principal authentication failed in test");
  return { actor, credential: created.credential };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("principal identity and authorization", () => {
  test("uses independent revocable credentials and never exposes digests", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    expect(store.authenticate(alice.credential)?.name).toBe("alice");
    expect(store.authenticate(bob.credential)?.name).toBe("bob");
    expect(JSON.stringify(store.listPrincipals())).not.toContain(alice.credential);
    store.revokePrincipal("alice");
    expect(store.authenticate(alice.credential)).toBeNull();
    expect(store.authenticate(bob.credential)?.name).toBe("bob");
    store.close();
  });

  test("rotates credentials without changing identity or stranding the mailbox", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = store.createPrincipal("bob");
    store.send(
      alice.actor,
      "rotation-1",
      { to: { kind: "principal", name: "bob" }, payload: "preserved" },
      1_000,
    );
    const replacement = store.issueCredential("bob", 2_000);
    store.revokeCredential(bob.credential_id, 3_000);
    expect(store.authenticate(bob.credential)).toBeNull();
    const rotatedBob = store.authenticate(replacement.credential)!;
    expect(rotatedBob.name).toBe("bob");
    expect(store.claim(rotatedBob, 1, 60, 4_000)[0].payload).toBe("preserved");
    store.close();
  });

  test("enforces channel membership on publish", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const mallory = principal(store, "mallory");
    store.createChannel(alice.actor, "builds", ["bob"]);
    expect(() =>
      store.send(mallory.actor, "forbidden-1", {
        to: { kind: "channel", name: "builds" },
        payload: "spoof",
      }),
    ).toThrow(new TransportError(403, "channel_forbidden", "channel send forbidden"));
    store.send(
      alice.actor,
      "allowed-1",
      {
        to: { kind: "channel", name: "builds" },
        payload: "opaque",
      },
      1_000,
    );
    expect(store.claim(bob.actor, 10, 60, 1_000)).toHaveLength(1);
    expect(store.claim(mallory.actor, 10, 60, 1_000)).toHaveLength(0);
    store.setChannelMember(alice.actor, "builds", "mallory", false);
    expect(store.listChannels(mallory.actor)).toMatchObject([
      { name: "builds", can_send: 0 },
    ]);
    expect(() =>
      store.send(mallory.actor, "still-forbidden", {
        to: { kind: "channel", name: "builds" },
        payload: "cannot publish",
      }),
    ).toThrow();
    store.removeChannelMember(alice.actor, "builds", "mallory");
    expect(store.listChannels(mallory.actor)).toEqual([]);
    store.close();
  });

  test("bounds channel fan-out and rejects channels without recipients", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    store.createChannel(alice.actor, "solo", []);
    expect(() =>
      store.send(
        alice.actor,
        "solo-1",
        { to: { kind: "channel", name: "solo" }, payload: "nobody" },
        1_000,
      ),
    ).toThrow();
    expect(() =>
      store.createChannel(
        alice.actor,
        "too-large",
        Array.from({ length: 100 }, (_, index) => `member-${index}`),
      ),
    ).toThrow();
    store.close();
  });
});

describe("durable transport contract", () => {
  test("deduplicates identical send and rejects conflicting reuse", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    principal(store, "bob");
    const input = {
      to: { kind: "principal" as const, name: "bob" },
      payload: "{\"taskId\":\"opaque-to-meshterm\"}",
      attributes: { arbitrary: true },
    };
    const first = store.send(alice.actor, "event-1", input, 1);
    const duplicate = store.send(alice.actor, "event-1", input, 2);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(() =>
      store.send(alice.actor, "event-1", { ...input, payload: "different" }, 3),
    ).toThrow(
      new TransportError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was reused with different input",
      ),
    );
    store.close();
  });

  test("returns one receipt across concurrent store processes", async () => {
    const created = createStore();
    const alice = principal(created.store, "alice");
    principal(created.store, "bob");
    const worker = join(import.meta.dir, "send-concurrency-worker.ts");
    const startAt = String(Date.now() + 200);
    const children = [1, 2].map(() =>
      Bun.spawn(
        [
          process.execPath,
          "run",
          worker,
          created.path,
          alice.credential,
          startAt,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(stderr).toBe("");
        return JSON.parse(stdout);
      }),
    );
    expect(new Set(results.map((result) => result.message_id)).size).toBe(1);
    expect(new Set(results.flatMap((result) => result.delivery_ids)).size).toBe(1);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    created.store.close();
  });

  test("claims oldest-first and excludes active leases", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const first = store.send(
      alice.actor,
      "fifo-1",
      { to: { kind: "principal", name: "bob" }, payload: "first" },
      1_000,
    );
    store.send(
      alice.actor,
      "fifo-2",
      { to: { kind: "principal", name: "bob" }, payload: "second" },
      2_000,
    );
    const claimed = store.claim(bob.actor, 1, 60, 3_000);
    expect(claimed.map((item) => item.payload)).toEqual(["first"]);
    expect(claimed[0].message_id).toBe(first.message_id);
    expect(store.claim(bob.actor, 10, 60, 3_000).map((item) => item.payload)).toEqual([
      "second",
    ]);
    store.close();
  });

  test("two store connections cannot claim the same delivery concurrently", () => {
    const created = createStore();
    const alice = principal(created.store, "alice");
    const bob = principal(created.store, "bob");
    created.store.send(
      alice.actor,
      "exclusive-1",
      { to: { kind: "principal", name: "bob" }, payload: "one owner" },
      1_000,
    );
    const competingStore = new TransportStore(created.path);
    const competingBob = competingStore.authenticate(bob.credential)!;
    const first = created.store.claim(bob.actor, 1, 60, 2_000);
    const second = competingStore.claim(competingBob, 1, 60, 2_000);
    expect([...first, ...second]).toHaveLength(1);
    expect([...first, ...second][0].payload).toBe("one owner");
    competingStore.close();
    created.store.close();
  });

  test("requires recipient and lease token to acknowledge", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    store.send(
      alice.actor,
      "ack-1",
      {
        to: { kind: "principal", name: "bob" },
        payload: "message",
      },
      1_000,
    );
    const delivery = store.claim(bob.actor, 1, 60, 1_000)[0];
    expect(() =>
      store.acknowledge(alice.actor, delivery.delivery_id, delivery.lease_token, 2_000),
    ).toThrow();
    expect(() =>
      store.acknowledge(bob.actor, delivery.delivery_id, "wrong", 2_000),
    ).toThrow();
    const ack = store.acknowledge(
      bob.actor,
      delivery.delivery_id,
      delivery.lease_token,
      2_000,
    );
    expect(ack.state).toBe("acknowledged");
    expect(
      store.acknowledge(
        bob.actor,
        delivery.delivery_id,
        delivery.lease_token,
        3_000,
      ),
    ).toEqual(ack);
    expect(store.claim(bob.actor, 10, 60, 4_000)).toEqual([]);
    store.close();
  });

  test("rejects ack and nack after the lease deadline", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    store.send(
      alice.actor,
      "expired-1",
      { to: { kind: "principal", name: "bob" }, payload: "expired" },
      1_000,
    );
    const delivery = store.claim(bob.actor, 1, 1, 1_000)[0];
    expect(() =>
      store.acknowledge(
        bob.actor,
        delivery.delivery_id,
        delivery.lease_token,
        2_001,
      ),
    ).toThrow(new TransportError(409, "stale_lease", "lease is not active"));
    expect(() =>
      store.nack(
        bob.actor,
        delivery.delivery_id,
        delivery.lease_token,
        0,
        "late",
        2_001,
      ),
    ).toThrow(new TransportError(409, "stale_lease", "lease is not active"));
    store.close();
  });

  test("redelivers after lease expiry and survives store restart", () => {
    const created = createStore();
    const alice = principal(created.store, "alice");
    const bob = principal(created.store, "bob");
    created.store.send(
      alice.actor,
      "crash-1",
      { to: { kind: "principal", name: "bob" }, payload: "survive crash" },
      1_000,
    );
    const beforeCrash = created.store.claim(bob.actor, 1, 1, 2_000)[0];
    created.store.close();

    const reopened = new TransportStore(created.path);
    const recoveredBob = reopened.authenticate(bob.credential)!;
    expect(reopened.claim(recoveredBob, 1, 10, 2_500)).toEqual([]);
    const afterCrash = reopened.claim(recoveredBob, 1, 10, 3_001)[0];
    expect(afterCrash.message_id).toBe(beforeCrash.message_id);
    expect(afterCrash.delivery_id).toBe(beforeCrash.delivery_id);
    expect(afterCrash.attempt_count).toBe(2);
    reopened.acknowledge(
      recoveredBob,
      afterCrash.delivery_id,
      afterCrash.lease_token,
      4_000,
    );
    expect(reopened.claim(recoveredBob, 10, 10, 20_000)).toEqual([]);
    reopened.close();
  });

  test("bounds retries and moves poison deliveries to dead letter", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    store.send(
      alice.actor,
      "poison-1",
      {
        to: { kind: "principal", name: "bob" },
        payload: "poison",
        max_attempts: 2,
      },
      1_000,
    );
    const first = store.claim(bob.actor, 1, 1, 1_000)[0];
    expect(
      store.nack(bob.actor, first.delivery_id, first.lease_token, 0, "invalid", 1_100)
        .state,
    ).toBe("queued");
    const second = store.claim(bob.actor, 1, 1, 1_101)[0];
    expect(
      store.nack(
        bob.actor,
        second.delivery_id,
        second.lease_token,
        0,
        "invalid",
        1_200,
      ).state,
    ).toBe("dead_letter");
    expect(store.claim(bob.actor, 10, 10, 2_000)).toEqual([]);
    expect(store.deadLetters(bob.actor)).toHaveLength(1);
    store.retryDeadLetter(second.delivery_id, 3_000);
    expect(store.claim(bob.actor, 1, 10, 3_000)).toHaveLength(1);
    store.close();
  });

  test("reaps a crashed final attempt into inspectable dead-letter state", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    store.send(
      alice.actor,
      "final-expiry-1",
      {
        to: { kind: "principal", name: "bob" },
        payload: "final attempt",
        max_attempts: 1,
      },
      1_000,
    );
    const leased = store.claim(bob.actor, 1, 1, 1_000)[0];
    expect(store.deadLetters(undefined, 2_001)).toMatchObject([
      { delivery_id: leased.delivery_id, last_error_code: "lease_expired" },
    ]);
    store.retryDeadLetter(leased.delivery_id, 3_000);
    expect(store.claim(bob.actor, 1, 10, 3_000)).toHaveLength(1);
    store.close();
  });

  test("paginates authorized history without mutating delivery state", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const mallory = principal(store, "mallory");
    store.send(
      alice.actor,
      "history-1",
      { to: { kind: "principal", name: "bob" }, payload: "first" },
      1_000,
    );
    store.send(
      alice.actor,
      "history-2",
      { to: { kind: "principal", name: "bob" }, payload: "second" },
      2_000,
    );
    const firstPage = store.history(bob.actor, 1);
    expect(firstPage.items[0].payload).toBe("second");
    expect(firstPage.next_cursor).not.toBeNull();
    expect(store.history(bob.actor, 1, firstPage.next_cursor!).items[0].payload).toBe(
      "first",
    );
    expect(store.history(mallory.actor, 10).items).toEqual([]);
    expect(store.metrics(bob.actor, 3_000).queue_depth).toBe(2);
    store.close();
  });

  test("allows sender deletion only after every delivery is terminal", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const sent = store.send(
      alice.actor,
      "delete-1",
      { to: { kind: "principal", name: "bob" }, payload: "terminal only" },
      1_000,
    );
    expect(() => store.deleteMessage(alice.actor, sent.message_id)).toThrow();
    const leased = store.claim(bob.actor, 1, 60, 2_000)[0];
    store.acknowledge(bob.actor, leased.delivery_id, leased.lease_token, 3_000);
    expect(() => store.deleteMessage(bob.actor, sent.message_id)).toThrow();
    store.deleteMessage(alice.actor, sent.message_id);
    expect(store.history(alice.actor).items).toEqual([]);
    store.close();
  });

  test("retention is terminal-only, canonicalizes time, and preserves reply parents", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const parent = store.send(
      alice.actor,
      "parent-1",
      { to: { kind: "principal", name: "bob" }, payload: "parent" },
      Date.UTC(2026, 0, 1),
    );
    const parentLease = store.claim(
      bob.actor,
      1,
      60,
      Date.UTC(2026, 0, 2),
    )[0];
    store.acknowledge(
      bob.actor,
      parentLease.delivery_id,
      parentLease.lease_token,
      Date.UTC(2026, 0, 2),
    );
    const child = store.send(
      bob.actor,
      "child-1",
      {
        to: { kind: "principal", name: "alice" },
        payload: "child",
        reply_to: parent.message_id,
      },
      Date.UTC(2026, 0, 3),
    );
    const childLease = store.claim(
      alice.actor,
      1,
      60,
      Date.UTC(2026, 0, 4),
    )[0];
    store.acknowledge(
      alice.actor,
      childLease.delivery_id,
      childLease.lease_token,
      Date.UTC(2026, 0, 4),
    );
    expect(() => store.deleteMessage(alice.actor, parent.message_id)).toThrow(
      new TransportError(
        409,
        "message_is_referenced",
        "message cannot be deleted while another message replies to it",
      ),
    );
    expect(() => store.retainTerminalBefore("July 1, 2026", 100)).toThrow(
      new TransportError(
        400,
        "invalid_retention_time",
        "before must be an ISO timestamp",
      ),
    );
    expect(() =>
      store.retainTerminalBefore("2026-02-30T00:00:00Z", 100),
    ).toThrow();
    expect(() =>
      store.retainTerminalBefore("2026-01-01T24:00:00Z", 100),
    ).toThrow();
    expect(store.retainTerminalBefore("2026-07-01T00:00:00Z", 100)).toBe(1);
    expect(store.getMessage(alice.actor, parent.message_id)).toMatchObject({
      message_id: parent.message_id,
    });
    expect(() => store.getMessage(bob.actor, child.message_id)).toThrow();
    store.close();
  });

  test("claims more than five small deliveries when requested", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    for (let index = 0; index < 8; index += 1) {
      store.send(
        alice.actor,
        `batch-${index}`,
        {
          to: { kind: "principal", name: "bob" },
          payload: `message-${index}`,
        },
        1_000 + index,
      );
    }
    const claimed = store.claim(bob.actor, 8, 60, 2_000);
    expect(claimed).toHaveLength(8);
    expect(claimed.map((item) => item.payload)).toEqual(
      Array.from({ length: 8 }, (_, index) => `message-${index}`),
    );
    store.close();
  });

  test("applies the claim byte cap before loading large payload rows", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const payload = "x".repeat(1024 * 1024);
    for (let index = 0; index < 6; index += 1) {
      store.send(
        alice.actor,
        `large-batch-${index}`,
        { to: { kind: "principal", name: "bob" }, payload },
        1_000 + index,
      );
    }
    expect(store.claim(bob.actor, 100, 60, 2_000)).toHaveLength(4);
    expect(store.metrics(bob.actor, 2_000)).toMatchObject({
      queue_depth: 2,
      active_leases: 4,
    });
    store.close();
  });

  test("reports queue, lease, retry, dead letter, and latency metrics", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    store.send(
      alice.actor,
      "metrics-1",
      { to: { kind: "principal", name: "bob" }, payload: "message" },
      1_000,
    );
    expect(store.metrics(bob.actor, 2_000).queue_depth).toBe(1);
    const claimed = store.claim(bob.actor, 1, 60, 2_000)[0];
    expect(store.metrics(bob.actor, 2_000).active_leases).toBe(1);
    store.acknowledge(bob.actor, claimed.delivery_id, claimed.lease_token, 3_000);
    const metrics = store.metrics(bob.actor, 3_000);
    expect(metrics.acknowledged).toBe(1);
    expect(metrics.queue_depth).toBe(0);
    expect(metrics.average_delivery_latency_ms).toBeGreaterThanOrEqual(0);
    store.close();
  });

  test("scopes metrics and treats expired leases as eligible queue work", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const mallory = principal(store, "mallory");
    store.send(
      alice.actor,
      "scoped-metrics-1",
      { to: { kind: "principal", name: "bob" }, payload: "private depth" },
      1_000,
    );
    store.claim(bob.actor, 1, 1, 1_000);
    expect(store.metrics(bob.actor, 3_000)).toMatchObject({
      queue_depth: 1,
      active_leases: 0,
    });
    expect(store.metrics(mallory.actor, 3_000)).toMatchObject({
      queue_depth: 0,
      active_leases: 0,
    });
    store.close();
  });
});

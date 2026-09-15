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

  test("matches replies by recipient, parent, and sender without leasing unrelated work", () => {
    const { store } = createStore();
    const alice = principal(store, "alice");
    const bob = principal(store, "bob");
    const mallory = principal(store, "mallory");
    store.createChannel(alice.actor, "matching-requests", ["bob", "mallory"]);
    const parent = store.send(
      alice.actor,
      "matching-parent",
      { to: { kind: "channel", name: "matching-requests" }, payload: "request" },
      1_000,
    );
    const reply = store.send(
      bob.actor,
      "matching-reply",
      {
        to: { kind: "principal", name: "alice" },
        payload: "matching reply",
        reply_to: parent.message_id,
      },
      1_001,
    );
    store.send(
      bob.actor,
      "matching-unrelated",
      { to: { kind: "principal", name: "alice" }, payload: "unrelated" },
      1_002,
    );
    store.send(
      mallory.actor,
      "matching-wrong-sender",
      {
        to: { kind: "principal", name: "alice" },
        payload: "wrong sender",
        reply_to: parent.message_id,
      },
      1_003,
    );
    store.revokePrincipal("bob");
    const matching = store.claim(
      alice.actor,
      1,
      60,
      2_000,
      { reply_to: parent.message_id, from: "bob" },
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      message_id: reply.message_id,
      payload: "matching reply",
      from: "bob",
    });
    const remaining = store.claim(alice.actor, 10, 60, 2_000);
    expect(remaining.map((item) => item.payload)).toEqual([
      "unrelated",
      "wrong sender",
    ]);
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

describe("scoped registration grants", () => {
  function clientCredential(id: string, fill = "a"): string {
    return `mtk_${id}.${fill.repeat(64)}`;
  }

  test("validates bounded namespaces, quotas, and global namespace uniqueness", () => {
    const { store } = createStore();
    const expiresAt = new Date(10_000).toISOString();
    expect(() => store.createRegistrationGrant("", 1, expiresAt, 0)).toThrow(
      new TransportError(
        400,
        "invalid_registration_namespace",
        "namespace must be 1 to 32 safe characters",
      ),
    );
    expect(() =>
      store.createRegistrationGrant("namespace-that-is-too-long-for-the-contract", 1, expiresAt, 0),
    ).toThrow();
    expect(() => store.createRegistrationGrant("valid", 0, expiresAt, 0)).toThrow();
    expect(() => store.createRegistrationGrant("valid", 1001, expiresAt, 0)).toThrow();
    const grantCredential = store.createRegistrationGrant("valid", 1, expiresAt, 0).credential;
    const grant = store.authenticateRegistrationGrant(grantCredential)!;
    expect(() => store.assertRegistrationGrantUsable(grant, 10_000)).toThrow(
      new TransportError(
        403,
        "registration_grant_expired",
        "registration grant is expired",
      ),
    );
    expect(() => store.createRegistrationGrant("valid", 1, expiresAt, 0)).toThrow(
      new TransportError(
        409,
        "registration_namespace_exists",
        "registration namespace already exists",
      ),
    );
    store.close();
  });

  test("registers atomically, returns idempotent retries, and enforces quota", () => {
    const { store } = createStore();
    const grantCredential = store.createRegistrationGrant(
      "sessions",
      1,
      new Date(10_000).toISOString(),
      0,
    ).credential;
    const grant = store.authenticateRegistrationGrant(grantCredential)!;
    const key = "00000000-0000-0000-0000-000000000001";
    const credential = clientCredential("00000000-0000-0000-0000-000000000002");
    const created = store.registerPrincipal(grant, key, "first", credential, 0);
    expect(created).toMatchObject({
      duplicate: false,
      principal: {
        name: "sessions-first-7ac1b8d7010b",
        kind: "agent",
        status: "active",
      },
    });
    expect(store.registerPrincipal(grant, key, "first", credential, 1)).toEqual({
      principal: created.principal,
      duplicate: true,
    });
    expect(() =>
      store.registerPrincipal(grant, key, "changed", credential, 1),
    ).toThrow(
      new TransportError(
        409,
        "registration_conflict",
        "registration key is already registered with different input",
      ),
    );
    expect(() =>
      store.registerPrincipal(
        grant,
        "00000000-0000-0000-0000-000000000003",
        "second",
        clientCredential("00000000-0000-0000-0000-000000000004"),
        1,
      ),
    ).toThrow(
      new TransportError(
        409,
        "registration_quota_exhausted",
        "registration grant quota exhausted",
      ),
    );
    const storedCredential = store.db
      .query("SELECT secret_hash FROM credentials WHERE id=?")
      .get("00000000-0000-0000-0000-000000000002") as {
      secret_hash: Uint8Array;
    };
    expect(JSON.stringify(storedCredential)).not.toContain(credential);
    expect(store.listRegistrationPrincipals(grant, 1)).toEqual([
      created.principal,
    ]);
    store.close();
  });

  test("keeps registrations and credentials across restart and revocation", () => {
    const created = createStore();
    const grantCredential = created.store.createRegistrationGrant(
      "restart",
      2,
      new Date(10_000).toISOString(),
      0,
    ).credential;
    const grant = created.store.authenticateRegistrationGrant(grantCredential)!;
    const credential = clientCredential("00000000-0000-0000-0000-000000000005", "b");
    const registration = created.store.registerPrincipal(
      grant,
      "00000000-0000-0000-0000-000000000006",
      "worker",
      credential,
      0,
    );
    created.store.close();

    const reopened = new TransportStore(created.path);
    const reopenedGrant = reopened.authenticateRegistrationGrant(grantCredential)!;
    expect(reopened.listRegistrationPrincipals(reopenedGrant, 1)).toEqual([
      registration.principal,
    ]);
    expect(reopened.authenticate(credential)?.id).toBe(registration.principal.id);
    reopened.revokePrincipal(registration.principal.name, 2);
    expect(
      reopened.registerPrincipal(
        reopenedGrant,
        "00000000-0000-0000-0000-000000000006",
        "worker",
        credential,
        3,
      ),
    ).toEqual({
      principal: { ...registration.principal, status: "revoked" },
      duplicate: true,
    });
    expect(reopened.authenticate(credential)).toBeNull();
    reopened.revokeRegistrationGrant(reopenedGrant.id, 2);
    expect(() => reopened.assertRegistrationGrantUsable(reopenedGrant, 2)).toThrow(
      new TransportError(
        403,
        "registration_grant_revoked",
        "registration grant is revoked",
      ),
    );
    reopened.close();
  });
});

describe("lease renewal", () => {
  test("extends only a live owned lease, preserves longer expiry, and survives restart", () => {
    const created = createStore();
    const alice = principal(created.store, "alice");
    const bob = principal(created.store, "bob");
    created.store.send(
      alice.actor,
      "renew-1",
      { to: { kind: "principal", name: "bob" }, payload: "renew me" },
      1_000,
    );
    const lease = created.store.claim(bob.actor, 1, 60, 1_000)[0];
    const extended = created.store.renewLease(
      bob.actor,
      lease.delivery_id,
      lease.lease_token,
      120,
      2_000,
    );
    expect(extended.lease_expires_at).toBe(new Date(122_000).toISOString());
    expect(
      created.store.renewLease(
        bob.actor,
        lease.delivery_id,
        lease.lease_token,
        1,
        3_000,
      ),
    ).toEqual(extended);
    expect(
      created.store.db
        .query("SELECT lease_expires_at FROM delivery_attempts WHERE delivery_id=?")
        .get(lease.delivery_id),
    ).toEqual({ lease_expires_at: extended.lease_expires_at });
    expect(() =>
      created.store.renewLease(
        alice.actor,
        lease.delivery_id,
        lease.lease_token,
        120,
        3_001,
      ),
    ).toThrow(
      new TransportError(404, "delivery_not_found", "delivery not found"),
    );
    created.store.close();

    const reopened = new TransportStore(created.path);
    const recoveredBob = reopened.authenticate(bob.credential)!;
    expect(() =>
      reopened.renewLease(
        recoveredBob,
        lease.delivery_id,
        lease.lease_token,
        120,
        122_001,
      ),
    ).toThrow(new TransportError(409, "stale_lease", "lease is not active"));
    expect(reopened.claim(recoveredBob, 1, 10, 122_001)).toHaveLength(1);
    reopened.close();
  });
});

import { expect, test } from "bun:test";
import { MeshtermClaimTimeoutError, MeshtermClientError } from "../../packages/client";
import { pause, receiveWithRecovery, RECOVERY_DELAY_MS } from "./recovery";

test("uncertain claim waits out its lease then resumes without a model call", async () => {
  let calls = 0; const delays: number[] = []; const notices: boolean[] = [];
  const item = { delivery_id: "recovered" } as any;
  const received = await receiveWithRecovery({ async wait(options) {
    expect(options?.leaseSeconds).toBe(120);
    if (++calls === 1) throw new MeshtermClaimTimeoutError();
    return item;
  } }, new AbortController().signal, recovering => notices.push(recovering), async ms => { delays.push(ms); });
  expect(received).toBe(item);
  expect(calls).toBe(2); expect(delays).toEqual([121000]); expect(notices).toEqual([true, false]);
});

test("persistent failure has only two recovery attempts; auth errors never retry", async () => {
  for (const error of [new MeshtermClaimTimeoutError(), new TypeError("fetch failed"), new MeshtermClientError(503, "private"), new MeshtermClientError(401, "private")]) {
    let calls = 0; const delays: number[] = [];
    await expect(receiveWithRecovery({ async wait() { calls++; throw error; } }, new AbortController().signal, () => {}, async ms => { delays.push(ms); })).rejects.toBe(error);
    const retry = !(error instanceof MeshtermClientError && error.status === 401);
    expect(calls).toBe(retry ? 3 : 1); expect(delays).toHaveLength(retry ? 2 : 0);
  }
});

test("stop cancels recovery promptly without another claim", async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = receiveWithRecovery({ async wait() { calls++; throw new MeshtermClaimTimeoutError(); } }, controller.signal, () => { setTimeout(() => controller.abort(), 1); });
  await expect(pending).rejects.toThrow("Listener stopped"); expect(calls).toBe(1);
  await expect(pause(RECOVERY_DELAY_MS, controller.signal)).rejects.toThrow("Listener stopped");
});

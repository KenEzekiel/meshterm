import { MeshtermClaimTimeoutError, MeshtermClientError } from "../../packages/client";
import type { AgentSession } from "./runtime";

// Match the lease requested by the listener, plus a small expiry margin.
export const LISTENER_LEASE_SECONDS = 120;
export const RECOVERY_DELAY_MS = (LISTENER_LEASE_SECONDS + 1) * 1000;

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Listener stopped")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function receiveWithRecovery(
  session: Pick<AgentSession, "wait">,
  signal: AbortSignal,
  notify: (recovering: boolean, attempt: number) => void,
  sleep = pause,
) {
  for (let failures = 0; ; failures++) {
    if (signal.aborted) throw new Error("Listener stopped");
    try {
      const item = await session.wait({ timeoutMs: 5000, leaseSeconds: LISTENER_LEASE_SECONDS, signal });
      if (failures) notify(false, failures);
      return item;
    } catch (error) {
      if (signal.aborted) throw error;
      const transient = error instanceof MeshtermClaimTimeoutError || error instanceof TypeError ||
        (error instanceof MeshtermClientError && [408, 429, 500, 502, 503, 504].includes(error.status));
      // Unknown claim outcomes must not be retried until their possible lease
      // expires. Limit retries so an outage cannot exhaust deliveries forever.
      if (!transient || failures >= 2) throw error;
      notify(true, failures + 1);
      await sleep(RECOVERY_DELAY_MS, signal);
    }
  }
}

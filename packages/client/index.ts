export interface MeshtermClientOptions {
  server: string;
  credential: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SendMessageInput {
  to: { kind: "principal" | "channel"; name: string };
  payload: string;
  content_type?: string;
  attributes?: Record<string, unknown>;
  reply_to?: string;
  max_attempts?: number;
}

export interface ClaimedDelivery {
  delivery_id: string;
  message_id: string;
  from: string;
  to: string;
  payload: string;
  content_type: string;
  attributes: Record<string, unknown> | null;
  reply_to: string | null;
  created_at: string;
  attempt_count: number;
  lease_token: string;
  lease_expires_at: string;
}

export interface ClaimFilter {
  reply_to?: string;
  from?: string;
}

export interface WaitForDeliveryOptions extends ClaimFilter {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  leaseSeconds?: number;
  signal?: AbortSignal;
}

export interface SendReceipt {
  message_id: string;
  delivery_ids: string[];
  duplicate: boolean;
  created_at: string;
}

export interface SendAndWaitResult {
  receipt: SendReceipt;
  reply: ClaimedDelivery | null;
}

export class MeshtermClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`Meshterm HTTP ${status}`);
    this.name = "MeshtermClientError";
  }
}

export class MeshtermClient {
  readonly #server: string;
  readonly #credential: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: MeshtermClientOptions) {
    const server = new URL(options.server);
    if (!["http:", "https:"].includes(server.protocol)) {
      throw new Error("Meshterm server must use HTTP or HTTPS");
    }
    if (!options.credential.startsWith("mtk_")) {
      throw new Error("Meshterm credential must start with mtk_");
    }
    this.#server = server.origin;
    this.#credential = options.credential;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async send(
    idempotencyKey: string,
    input: SendMessageInput,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.request("/v1/messages", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
      signal,
    });
  }

  async claim(
    limit = 10,
    leaseSeconds = 60,
    signal?: AbortSignal,
  ): Promise<{
    items: ClaimedDelivery[];
  }> {
    return this.request("/v1/claims", {
      method: "POST",
      body: JSON.stringify({ limit, lease_seconds: leaseSeconds }),
      signal,
    });
  }

  async claimMatching(
    filter: ClaimFilter,
    options: { limit?: number; leaseSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<{ items: ClaimedDelivery[] }> {
    if (!filter.reply_to || !filter.from) {
      throw new Error("reply_to and from are required for a matching claim");
    }
    const body: Record<string, unknown> = {
      limit: options.limit ?? 1,
      lease_seconds: options.leaseSeconds ?? 60,
    };
    if (filter.reply_to !== undefined) body.reply_to = filter.reply_to;
    if (filter.from !== undefined) body.from = filter.from;
    return this.request("/v1/claims/matching", {
      method: "POST",
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  async waitForDelivery(
    options: WaitForDeliveryOptions = {},
  ): Promise<ClaimedDelivery | null> {
    const waitOptions = validateWaitOptions(options);
    const { timeoutMs, pollIntervalMs, maxPollIntervalMs, leaseSeconds } =
      waitOptions;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let delayMs = pollIntervalMs;

    while (true) {
      throwIfAborted(waitOptions.signal);
      if (timeoutMs > 0 && Date.now() >= deadline) return null;
      const remainingMs = deadline - Date.now();
      const requestTimeoutMs = Math.max(
        1,
        Math.min(this.#timeoutMs, timeoutMs === 0 ? this.#timeoutMs : remainingMs),
      );
      const requestSignal = createRequestSignal(waitOptions.signal, requestTimeoutMs);
      let result: { items: ClaimedDelivery[] } | undefined;
      try {
        result =
          waitOptions.reply_to !== undefined || waitOptions.from !== undefined
            ? await this.claimMatching(waitOptions, {
                limit: 1,
                leaseSeconds,
                signal: requestSignal.signal,
              })
            : await this.claim(1, leaseSeconds, requestSignal.signal);
      } catch (error) {
        if (waitOptions.signal?.aborted) throw abortError();
        if (requestSignal.signal.aborted) {
          if (timeoutMs === 0 || Date.now() >= deadline) return null;
          // A single poll may hit the client's request timeout before the
          // bounded wait expires. Continue polling until the wait deadline.
        } else {
          throw error;
        }
      } finally {
        requestSignal.cleanup();
      }

      const item = result?.items?.[0];
      if (item) {
        if (waitOptions.signal?.aborted) {
          await this.releaseCancelledDelivery(item);
          throw abortError();
        }
        return item;
      }
      if (timeoutMs === 0 || Date.now() >= deadline) return null;

      const waitMs = Math.min(delayMs, deadline - Date.now());
      await delay(waitMs, waitOptions.signal);
      delayMs = Math.min(
        maxPollIntervalMs,
        Math.max(pollIntervalMs, delayMs === 0 ? 1 : delayMs * 2),
      );
    }
  }

  async sendAndWait(
    idempotencyKey: string,
    input: SendMessageInput,
    options: WaitForDeliveryOptions = {},
  ): Promise<SendAndWaitResult> {
    const waitOptions = validateWaitOptions(options);
    if (input.to.kind !== "principal") {
      throw new Error("sendAndWait requires a principal target");
    }
    const receipt = (await this.send(
      idempotencyKey,
      input,
      waitOptions.signal,
    )) as SendReceipt;
    if (!receipt || typeof receipt.message_id !== "string") {
      throw new Error("Meshterm send response did not include a message ID");
    }
    try {
      const reply = await this.waitForDelivery({
        ...waitOptions,
        reply_to: receipt.message_id,
        from: input.to.name,
      });
      return { receipt, reply };
    } catch (error) {
      throw attachReceipt(error, receipt);
    }
  }

  async ack(deliveryId: string, leaseToken: string): Promise<any> {
    return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ lease_token: leaseToken }),
    });
  }

  async nack(
    deliveryId: string,
    leaseToken: string,
    options: { retryAfterSeconds?: number; reasonCode?: string } = {},
  ): Promise<any> {
    return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/nack`, {
      method: "POST",
      body: JSON.stringify({
        lease_token: leaseToken,
        ...(options.retryAfterSeconds !== undefined
          ? { retry_after_seconds: options.retryAfterSeconds }
          : {}),
        ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
      }),
    });
  }

  async message(messageId: string): Promise<any> {
    return this.request(`/v1/messages/${encodeURIComponent(messageId)}`);
  }

  async deleteMessage(messageId: string): Promise<any> {
    return this.request(`/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
  }

  async history(limit = 50, cursor?: string): Promise<any> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/v1/history?${query}`);
  }

  async metrics(): Promise<any> {
    return this.request("/v1/metrics");
  }

  async request(path: string, init: RequestInit = {}): Promise<any> {
    const requestSignal = createRequestSignal(
      init.signal ?? undefined,
      this.#timeoutMs,
    );
    try {
      const response = await this.#fetch(`${this.#server}${path}`, {
        ...init,
        signal: requestSignal.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#credential}`,
          ...init.headers,
        },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new MeshtermClientError(response.status, text.slice(0, 4096));
      }
      return text ? JSON.parse(text) : null;
    } finally {
      requestSignal.cleanup();
    }
  }

  private async releaseCancelledDelivery(item: ClaimedDelivery): Promise<void> {
    try {
      await this.nack(item.delivery_id, item.lease_token, {
        retryAfterSeconds: 0,
        reasonCode: "wait_cancelled",
      });
    } catch {
      // The lease will expire and be retried if cancellation raced with expiry.
    }
  }
}

function validateWaitOptions(
  options: WaitForDeliveryOptions,
): Required<
  Pick<
    WaitForDeliveryOptions,
    "timeoutMs" | "pollIntervalMs" | "maxPollIntervalMs" | "leaseSeconds"
  >
> &
  Omit<WaitForDeliveryOptions, "timeoutMs" | "pollIntervalMs" | "maxPollIntervalMs" | "leaseSeconds"> {
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? 30_000,
    0,
    300_000,
    "timeoutMs",
  );
  const pollIntervalMs = boundedInteger(
    options.pollIntervalMs ?? 100,
    1,
    60_000,
    "pollIntervalMs",
  );
  const maxPollIntervalMs = boundedInteger(
    options.maxPollIntervalMs ?? Math.max(2_000, pollIntervalMs),
    pollIntervalMs,
    60_000,
    "maxPollIntervalMs",
  );
  const leaseSeconds = boundedInteger(
    options.leaseSeconds ?? 60,
    1,
    3_600,
    "leaseSeconds",
  );
  return {
    ...options,
    timeoutMs,
    pollIntervalMs,
    maxPollIntervalMs,
    leaseSeconds,
  };
}

function attachReceipt(error: unknown, receipt: SendReceipt): Error {
  if (error instanceof Error) {
    if ("receipt" in error) return error;
    try {
      Object.defineProperty(error, "receipt", {
        value: receipt,
        enumerable: true,
      });
      return error;
    } catch {
      // Fall through for non-extensible platform errors.
    }
  }
  const wrapped = new Error("Meshterm send-and-wait failed", { cause: error });
  Object.defineProperty(wrapped, "receipt", {
    value: receipt,
    enumerable: true,
  });
  return wrapped;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function createRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

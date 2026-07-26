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

  async send(idempotencyKey: string, input: SendMessageInput): Promise<any> {
    return this.request("/v1/messages", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  async claim(limit = 10, leaseSeconds = 60): Promise<{
    items: ClaimedDelivery[];
  }> {
    return this.request("/v1/claims", {
      method: "POST",
      body: JSON.stringify({ limit, lease_seconds: leaseSeconds }),
    });
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
    const response = await this.#fetch(`${this.#server}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.#timeoutMs),
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
  }
}

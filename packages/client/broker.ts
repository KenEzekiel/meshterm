import { randomUUID } from "crypto";
import { createConnection } from "net";

export const STATUS_BROKER_VERSION = 1 as const;
export const STATUS_BROKER_MAX_REQUEST_BYTES = 512;
export const STATUS_BROKER_MAX_RESPONSE_BYTES = 8_192;
export const STATUS_BROKER_DEFAULT_TIMEOUT_MS = 3_000;

export interface BrokerStatus {
  ready: boolean;
  schema_version: number;
  journal_mode: string;
  queue_depth: number;
  active_leases: number;
  acknowledged: number;
  dead_letters: number;
  discarded: number;
  retries: number;
  oldest_message_age_ms: number;
  average_delivery_latency_ms: number;
}

export class MeshtermBrokerError extends Error {
  constructor(
    public readonly code:
      | "broker_unavailable"
      | "broker_timeout"
      | "invalid_broker_response"
      | "broker_rejected",
    message: string,
  ) {
    super(message);
    this.name = "MeshtermBrokerError";
  }
}

const statusKeys = [
  "ready",
  "schema_version",
  "journal_mode",
  "queue_depth",
  "active_leases",
  "acknowledged",
  "dead_letters",
  "discarded",
  "retries",
  "oldest_message_age_ms",
  "average_delivery_latency_ms",
] as const;
const brokerErrorMessages = {
  unauthorized_peer: "peer is not authorized",
  invalid_request: "request is invalid",
  unsupported_version: "protocol version is unsupported",
  profile_unavailable: "status profile is unavailable",
  upstream_unavailable: "status is unavailable",
  upstream_unauthorized: "status authorization failed",
  invalid_upstream_response: "status response is invalid",
  audit_unavailable: "audit is unavailable",
  internal_error: "status is unavailable",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function hasDuplicateObjectKeys(text: string): boolean {
  const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map((match) =>
    JSON.parse(match[0].replace(/\s*:$/, "")),
  );
  return new Set(keys).size !== keys.length;
}

function boundedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function boundedNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function validateStatus(value: unknown): BrokerStatus {
  if (!isRecord(value) || !hasExactKeys(value, statusKeys)) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid status response",
    );
  }
  if (
    typeof value.ready !== "boolean" ||
    !boundedInteger(value.schema_version) ||
    typeof value.journal_mode !== "string" ||
    value.journal_mode.length < 1 ||
    value.journal_mode.length > 16
  ) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid status response",
    );
  }
  for (const key of statusKeys.slice(3, -1)) {
    if (!boundedInteger(value[key])) {
      throw new MeshtermBrokerError(
        "invalid_broker_response",
        "broker returned an invalid status response",
      );
    }
  }
  if (!boundedNumber(value.average_delivery_latency_ms)) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid status response",
    );
  }
  return value as unknown as BrokerStatus;
}

function parseResponse(text: string, requestId: string): BrokerStatus {
  if (hasDuplicateObjectKeys(text)) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid response",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid response",
    );
  }
  if (!isRecord(value) || value.version !== STATUS_BROKER_VERSION) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker returned an invalid response",
    );
  }
  if (value.request_id !== requestId) {
    throw new MeshtermBrokerError(
      "invalid_broker_response",
      "broker response did not match the request",
    );
  }
  if (value.ok === true) {
    if (!hasExactKeys(value, ["version", "request_id", "ok", "status"])) {
      throw new MeshtermBrokerError(
        "invalid_broker_response",
        "broker returned an invalid response",
      );
    }
    return validateStatus(value.status);
  }
  if (
    value.ok === false &&
    hasExactKeys(value, ["version", "request_id", "ok", "error"]) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["code", "message"]) &&
    typeof value.error.code === "string" &&
    value.error.code in brokerErrorMessages &&
    typeof value.error.message === "string" &&
    value.error.code.length <= 64 &&
    value.error.message.length <= 160
  ) {
    throw new MeshtermBrokerError(
      "broker_rejected",
      brokerErrorMessages[
        value.error.code as keyof typeof brokerErrorMessages
      ],
    );
  }
  throw new MeshtermBrokerError(
    "invalid_broker_response",
    "broker returned an invalid response",
  );
}

export function requestStatusViaBroker(
  socketPath: string,
  timeoutMs = STATUS_BROKER_DEFAULT_TIMEOUT_MS,
): Promise<BrokerStatus> {
  if (!socketPath.startsWith("/") || socketPath.length > 256) {
    throw new MeshtermBrokerError(
      "broker_unavailable",
      "broker socket must be an absolute path",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new MeshtermBrokerError(
      "broker_unavailable",
      "broker timeout is invalid",
    );
  }
  const requestId = randomUUID();
  const request = `${JSON.stringify({
    version: STATUS_BROKER_VERSION,
    request_id: requestId,
    operation: "status",
  })}\n`;
  if (Buffer.byteLength(request) > STATUS_BROKER_MAX_REQUEST_BYTES) {
    throw new MeshtermBrokerError(
      "broker_unavailable",
      "broker request exceeds its size limit",
    );
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (error?: Error, result?: BrokerStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new MeshtermBrokerError("broker_timeout", "broker request timed out"),
        ),
      timeoutMs,
    );

    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > STATUS_BROKER_MAX_RESPONSE_BYTES) {
        finish(
          new MeshtermBrokerError(
            "invalid_broker_response",
            "broker response exceeds its size limit",
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (settled) return;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
      } catch {
        finish(
          new MeshtermBrokerError(
            "invalid_broker_response",
            "broker returned an invalid response",
          ),
        );
        return;
      }
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
        finish(
          new MeshtermBrokerError(
            "invalid_broker_response",
            "broker returned an invalid response",
          ),
        );
        return;
      }
      try {
        finish(undefined, parseResponse(text.slice(0, -1), requestId));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("broker failed"));
      }
    });
    socket.once("error", () =>
      finish(
        new MeshtermBrokerError(
          "broker_unavailable",
          "broker is unavailable",
        ),
      ),
    );
  });
}

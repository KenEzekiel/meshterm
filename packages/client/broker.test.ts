import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MeshtermBrokerError,
  requestStatusViaBroker,
  STATUS_BROKER_MAX_RESPONSE_BYTES,
} from "./broker";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fakeBroker(
  responder: (request: Record<string, unknown>, socket: Socket) => void,
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "meshterm-broker-"));
  directories.push(directory);
  const path = join(directory, "status.sock");
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.endsWith("\n")) responder(JSON.parse(text), socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return path;
}

function statusResponse(request: Record<string, unknown>) {
  return {
    version: 1,
    request_id: request.request_id,
    ok: true,
    status: {
      ready: true,
      schema_version: 2,
      journal_mode: "wal",
      queue_depth: 0,
      active_leases: 0,
      acknowledged: 1,
      dead_letters: 0,
      discarded: 0,
      retries: 0,
      oldest_message_age_ms: 0,
      average_delivery_latency_ms: 12.5,
    },
  };
}

describe("credentialless status broker client", () => {
  test("sends only the closed v1 status request and validates the response", async () => {
    const path = await fakeBroker((request, socket) => {
      expect(Object.keys(request).sort()).toEqual([
        "operation",
        "request_id",
        "version",
      ]);
      expect(request.operation).toBe("status");
      expect(request.version).toBe(1);
      socket.end(`${JSON.stringify(statusResponse(request))}\n`);
    });
    expect(await requestStatusViaBroker(path)).toMatchObject({
      ready: true,
      schema_version: 2,
      acknowledged: 1,
    });
  });

  test("rejects a mismatched request id", async () => {
    const path = await fakeBroker((request, socket) => {
      const response = statusResponse(request);
      response.request_id = "different";
      socket.end(`${JSON.stringify(response)}\n`);
    });
    await expect(requestStatusViaBroker(path)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });
  });

  test("rejects unknown and duplicate fields", async () => {
    const unknown = await fakeBroker((request, socket) => {
      socket.end(
        `${JSON.stringify({ ...statusResponse(request), extra: true })}\n`,
      );
    });
    await expect(requestStatusViaBroker(unknown)).rejects.toBeInstanceOf(
      MeshtermBrokerError,
    );

    const duplicate = await fakeBroker((request, socket) => {
      const response = JSON.stringify(statusResponse(request));
      socket.end(`${response.slice(0, -1)},"ok":true}\n`);
    });
    await expect(requestStatusViaBroker(duplicate)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });
  });

  test("rejects malformed, oversized, and multiple responses", async () => {
    const malformed = await fakeBroker((_request, socket) =>
      socket.end("{bad json}\n"),
    );
    await expect(requestStatusViaBroker(malformed)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });

    const oversized = await fakeBroker((_request, socket) =>
      socket.end(`${"x".repeat(STATUS_BROKER_MAX_RESPONSE_BYTES + 1)}\n`),
    );
    await expect(requestStatusViaBroker(oversized)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });

    const multiple = await fakeBroker((request, socket) => {
      const response = JSON.stringify(statusResponse(request));
      socket.end(`${response}\n${response}\n`);
    });
    await expect(requestStatusViaBroker(multiple)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });
  });

  test("rejects negative, non-finite, and out-of-schema metrics", async () => {
    const path = await fakeBroker((request, socket) => {
      const response = statusResponse(request);
      response.status.queue_depth = -1;
      socket.end(`${JSON.stringify(response)}\n`);
    });
    await expect(requestStatusViaBroker(path)).rejects.toMatchObject({
      code: "invalid_broker_response",
    });
  });

  test("surfaces bounded broker errors without raw details", async () => {
    const path = await fakeBroker((request, socket) =>
      socket.end(
        `${JSON.stringify({
          version: 1,
          request_id: request.request_id,
          ok: false,
          error: { code: "upstream_unavailable", message: "status is unavailable" },
        })}\n`,
      ),
    );
    await expect(requestStatusViaBroker(path)).rejects.toMatchObject({
      code: "broker_rejected",
      message: "status is unavailable",
    });

    const raw = await fakeBroker((request, socket) =>
      socket.end(
        `${JSON.stringify({
          version: 1,
          request_id: request.request_id,
          ok: false,
          error: { code: "unknown", message: "credential=must-not-surface" },
        })}\n`,
      ),
    );
    await expect(requestStatusViaBroker(raw)).rejects.toMatchObject({
      code: "invalid_broker_response",
      message: "broker returned an invalid response",
    });
  });

  test("fails on unavailable sockets and timeouts", async () => {
    await expect(
      requestStatusViaBroker("/tmp/meshterm-definitely-missing.sock", 100),
    ).rejects.toMatchObject({ code: "broker_unavailable" });

    const path = await fakeBroker(() => {});
    await expect(requestStatusViaBroker(path, 100)).rejects.toMatchObject({
      code: "broker_timeout",
    });
  });
});

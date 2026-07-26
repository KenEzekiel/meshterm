#!/usr/bin/env bun

import { timingSafeEqual } from "crypto";
import {
  LATEST_SCHEMA_VERSION,
  TransportError,
  TransportStore,
} from "./transport";

export interface ServerOptions {
  port?: number;
  hostname?: string;
  databasePath?: string;
  operatorToken?: string;
}

function json(
  data: unknown,
  status = 200,
  requestId?: string,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function bearer(req: Request): string {
  const value = req.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new TransportError(400, "invalid_json", "request body must be a JSON object");
  }
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.MESH_PORT ?? 4200);
  const hostname = options.hostname ?? process.env.MESH_HOST ?? "127.0.0.1";
  const databasePath =
    options.databasePath ?? process.env.MESH_DATABASE ?? "./meshterm.sqlite";
  const operatorToken =
    options.operatorToken ?? process.env.MESH_OPERATOR_TOKEN ?? "";
  if (operatorToken.length < 32) {
    throw new Error("MESH_OPERATOR_TOKEN must contain at least 32 characters");
  }
  const store = new TransportStore(databasePath);

  const server = Bun.serve({
    port,
    hostname,
    // A decoded 1 MiB string can expand to roughly 6 MiB when JSON-escaped.
    maxRequestBodySize: 7_500_000,
    async fetch(req) {
      const requestId = crypto.randomUUID();
      const url = new URL(req.url);
      const { pathname: path } = url;
      try {
        if (req.method === "GET" && (path === "/livez" || path === "/health")) {
          return json({ ok: true }, 200, requestId);
        }
        if (req.method === "GET" && path === "/readyz") {
          const integrity = store.integrity();
          return json(
            {
              ok:
                integrity.ok &&
                integrity.schema_version === LATEST_SCHEMA_VERSION &&
                integrity.journal_mode === "wal",
              store: integrity,
            },
            integrity.ok &&
              integrity.schema_version === LATEST_SCHEMA_VERSION &&
              integrity.journal_mode === "wal"
              ? 200
              : 503,
            requestId,
          );
        }

        const token = bearer(req);
        const isOperator =
          token.length > 0 && safeEqual(token, operatorToken);
        const principal = isOperator ? null : store.authenticate(token);

        if (path.startsWith("/v1/operator/")) {
          if (!isOperator) {
            return json(
              { error: { code: "unauthorized", message: "operator credential required" } },
              401,
              requestId,
            );
          }
          if (req.method === "POST" && path === "/v1/operator/principals") {
            const input = await body(req);
            const created = store.createPrincipal(
              String(input.name ?? ""),
              input.kind === "service" ? "service" : "agent",
            );
            log("principal.created", {
              request_id: requestId,
              principal_id: created.principal.id,
            });
            return json(created, 201, requestId);
          }
          const revokeMatch = path.match(
            /^\/v1\/operator\/principals\/([^/]+)\/revoke$/,
          );
          if (req.method === "POST" && revokeMatch) {
            store.revokePrincipal(decodeURIComponent(revokeMatch[1]));
            log("principal.revoked", { request_id: requestId });
            return json({ ok: true }, 200, requestId);
          }
          if (req.method === "GET" && path === "/v1/operator/principals") {
            return json({ principals: store.listPrincipals() }, 200, requestId);
          }
          const issueCredentialMatch = path.match(
            /^\/v1\/operator\/principals\/([^/]+)\/credentials$/,
          );
          if (req.method === "POST" && issueCredentialMatch) {
            return json(
              store.issueCredential(
                decodeURIComponent(issueCredentialMatch[1]),
              ),
              201,
              requestId,
            );
          }
          const revokeCredentialMatch = path.match(
            /^\/v1\/operator\/credentials\/([^/]+)$/,
          );
          if (req.method === "DELETE" && revokeCredentialMatch) {
            store.revokeCredential(
              decodeURIComponent(revokeCredentialMatch[1]),
            );
            return json({ ok: true }, 200, requestId);
          }
          if (req.method === "GET" && path === "/v1/operator/dead-letters") {
            return json({ items: store.deadLetters() }, 200, requestId);
          }
          if (req.method === "GET" && path === "/v1/operator/metrics") {
            return json(store.metrics(), 200, requestId);
          }
          if (req.method === "DELETE" && path === "/v1/operator/retention") {
            const before = url.searchParams.get("before") ?? "";
            const deleted = store.retainTerminalBefore(
              before,
              Number(url.searchParams.get("limit") ?? 1_000),
            );
            return json({ ok: true, deleted }, 200, requestId);
          }
          const retryMatch = path.match(
            /^\/v1\/operator\/dead-letters\/([^/]+)\/retry$/,
          );
          if (req.method === "POST" && retryMatch) {
            store.retryDeadLetter(decodeURIComponent(retryMatch[1]));
            return json({ ok: true, state: "queued" }, 200, requestId);
          }
          const discardMatch = path.match(
            /^\/v1\/operator\/dead-letters\/([^/]+)$/,
          );
          if (req.method === "DELETE" && discardMatch) {
            store.discardDeadLetter(decodeURIComponent(discardMatch[1]));
            return json({ ok: true, state: "discarded" }, 200, requestId);
          }
          return json(
            { error: { code: "not_found", message: "route not found" } },
            404,
            requestId,
          );
        }

        if (!principal) {
          return json(
            { error: { code: "unauthorized", message: "valid bearer credential required" } },
            401,
            requestId,
          );
        }

        if (req.method === "GET" && path === "/v1/principals") {
          return json(
            {
              principals: store
                .listPrincipals()
                .filter((entry) => entry.status === "active")
                .map(({ id, name, kind, status }) => ({ id, name, kind, status })),
            },
            200,
            requestId,
          );
        }
        if (req.method === "POST" && path === "/v1/channels") {
          const input = await body(req);
          const members = Array.isArray(input.members)
            ? input.members.map(String)
            : [];
          const channel = store.createChannel(
            principal,
            String(input.name ?? ""),
            members,
          );
          return json({ channel }, 201, requestId);
        }
        if (req.method === "GET" && path === "/v1/channels") {
          return json({ channels: store.listChannels(principal) }, 200, requestId);
        }
        const channelMemberMatch = path.match(
          /^\/v1\/channels\/([^/]+)\/members\/([^/]+)$/,
        );
        if (req.method === "PATCH" && channelMemberMatch) {
          const input = await body(req);
          store.setChannelMember(
            principal,
            decodeURIComponent(channelMemberMatch[1]),
            decodeURIComponent(channelMemberMatch[2]),
            input.can_send === true,
          );
          return json({ ok: true }, 200, requestId);
        }
        if (req.method === "DELETE" && channelMemberMatch) {
          store.removeChannelMember(
            principal,
            decodeURIComponent(channelMemberMatch[1]),
            decodeURIComponent(channelMemberMatch[2]),
          );
          return json({ ok: true }, 200, requestId);
        }
        if (req.method === "POST" && path === "/v1/messages") {
          const input = await body(req);
          const key = req.headers.get("idempotency-key") ?? "";
          const receipt = store.send(
            principal,
            key,
            input as unknown as Parameters<TransportStore["send"]>[2],
          );
          log("message.accepted", {
            request_id: requestId,
            principal_id: principal.id,
            message_id: receipt.message_id,
            duplicate: receipt.duplicate,
          });
          return json(receipt, receipt.duplicate ? 200 : 202, requestId);
        }
        if (req.method === "POST" && path === "/v1/claims") {
          const input = await body(req);
          const items = store.claim(
            principal,
            input.limit === undefined ? 10 : Number(input.limit),
            input.lease_seconds === undefined
              ? 60
              : Number(input.lease_seconds),
          );
          log("deliveries.claimed", {
            request_id: requestId,
            principal_id: principal.id,
            count: items.length,
          });
          return json({ items }, 200, requestId);
        }
        const ackMatch = path.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
        if (req.method === "POST" && ackMatch) {
          const input = await body(req);
          const result = store.acknowledge(
            principal,
            decodeURIComponent(ackMatch[1]),
            String(input.lease_token ?? ""),
          );
          log("delivery.acknowledged", {
            request_id: requestId,
            principal_id: principal.id,
            delivery_id: ackMatch[1],
          });
          return json(result, 200, requestId);
        }
        const nackMatch = path.match(/^\/v1\/deliveries\/([^/]+)\/nack$/);
        if (req.method === "POST" && nackMatch) {
          const input = await body(req);
          const result = store.nack(
            principal,
            decodeURIComponent(nackMatch[1]),
            String(input.lease_token ?? ""),
            input.retry_after_seconds === undefined
              ? undefined
              : Number(input.retry_after_seconds),
            input.reason_code === undefined
              ? undefined
              : String(input.reason_code),
          );
          log("delivery.rejected", {
            request_id: requestId,
            principal_id: principal.id,
            delivery_id: nackMatch[1],
            state: result.state,
          });
          return json(result, 200, requestId);
        }
        if (req.method === "GET" && path === "/v1/history") {
          return json(
            store.history(
              principal,
              Number(url.searchParams.get("limit") ?? 50),
              url.searchParams.get("cursor") ?? undefined,
            ),
            200,
            requestId,
          );
        }
        const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
        if (req.method === "GET" && messageMatch) {
          return json(
            store.getMessage(principal, decodeURIComponent(messageMatch[1])),
            200,
            requestId,
          );
        }
        if (req.method === "DELETE" && messageMatch) {
          store.deleteMessage(
            principal,
            decodeURIComponent(messageMatch[1]),
          );
          return json({ ok: true, deleted: messageMatch[1] }, 200, requestId);
        }
        if (req.method === "GET" && path === "/v1/dead-letters") {
          return json({ items: store.deadLetters(principal) }, 200, requestId);
        }
        if (req.method === "GET" && path === "/v1/metrics") {
          return json(store.metrics(principal), 200, requestId);
        }
        if (path.startsWith("/messages") || path.startsWith("/agents") || path.startsWith("/rooms") || path.startsWith("/roles") || path.startsWith("/skills") || path.startsWith("/tasks")) {
          return json(
            {
              error: {
                code: "legacy_api_removed",
                message: "use the authenticated /v1 transport API; see docs/MIGRATION_V1.md",
              },
            },
            410,
            requestId,
          );
        }
        return json(
          { error: { code: "not_found", message: "route not found" } },
          404,
          requestId,
        );
      } catch (error) {
        const failure =
          error instanceof TransportError
            ? error
            : new TransportError(500, "internal_error", "internal server error");
        log("request.failed", {
          request_id: requestId,
          code: failure.code,
          status: failure.status,
        });
        return json(
          { error: { code: failure.code, message: failure.message } },
          failure.status,
          requestId,
        );
      }
    },
  });
  log("server.started", {
    hostname: server.hostname,
    port: server.port,
    database: databasePath,
  });
  return {
    server,
    store,
    stop() {
      server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  startServer();
}

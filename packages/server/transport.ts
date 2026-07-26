import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

export type PrincipalKind = "agent" | "service";
export type DeliveryState = "queued" | "leased" | "acknowledged" | "dead_letter";

export interface Principal {
  id: string;
  name: string;
  kind: PrincipalKind;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface AuthenticatedPrincipal extends Principal {
  credential_id: string;
}

export interface SendInput {
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

export class TransportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ATTRIBUTES_BYTES = 16 * 1024;
const MAX_CLAIM_BYTES = 5 * 1024 * 1024;
export const LATEST_SCHEMA_VERSION = 2;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isStrictIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function equalDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function stableInputHash(senderId: string, input: SendInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        senderId,
        to: input.to,
        payload: input.payload,
        content_type: input.content_type ?? "text/plain",
        attributes: input.attributes ?? null,
        reply_to: input.reply_to ?? null,
        max_attempts: input.max_attempts ?? 5,
      }),
    )
    .digest("hex");
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export class TransportStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('agent','service')),
        status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        secret_hash BLOB NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES principals(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        can_send INTEGER NOT NULL CHECK(can_send IN (0,1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, principal_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL REFERENCES principals(id),
        route_kind TEXT NOT NULL CHECK(route_kind IN ('principal','channel')),
        route_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        content_type TEXT NOT NULL,
        attributes_json TEXT,
        reply_to TEXT REFERENCES messages(id),
        idempotency_key TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(sender_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES principals(id),
        ordinal INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('queued','leased','acknowledged','dead_letter','discarded')),
        available_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        lease_owner_id TEXT REFERENCES principals(id),
        lease_token_hash BLOB,
        leased_at TEXT,
        lease_expires_at TEXT,
        acknowledged_at TEXT,
        dead_lettered_at TEXT,
        discarded_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(message_id, recipient_id)
      );
      CREATE INDEX IF NOT EXISTS deliveries_claim_idx
        ON deliveries(recipient_id, state, available_at, created_at, id);
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT CHECK(outcome IN ('acknowledged','rejected','expired','dead_letter')),
        reason_code TEXT,
        UNIQUE(delivery_id, attempt_number)
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;
    `);
    const deliveryColumns = this.db
      .query("PRAGMA table_info(deliveries)")
      .all() as Array<{ name: string }>;
    if (!deliveryColumns.some((column) => column.name === "ordinal")) {
      this.db.exec(
        "ALTER TABLE deliveries ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.db
      .query(
        `INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (2,?)`,
      )
      .run(iso(Date.now()));
  }

  integrity(): { ok: boolean; journal_mode: string; schema_version: number } {
    const integrity = this.db.query("PRAGMA integrity_check").get() as Record<string, unknown>;
    const journal = this.db.query("PRAGMA journal_mode").get() as Record<string, unknown>;
    const schema = this.db
      .query("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")
      .get() as { version: number };
    return {
      ok: Object.values(integrity)[0] === "ok",
      journal_mode: String(Object.values(journal)[0]),
      schema_version: schema.version,
    };
  }

  createPrincipal(
    name: string,
    kind: PrincipalKind = "agent",
    now = Date.now(),
  ): { principal: Principal; credential_id: string; credential: string } {
    if (!principalPattern.test(name)) {
      throw new TransportError(400, "invalid_principal", "invalid principal name");
    }
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const credential = `mtk_${credentialId}.${randomBytes(32).toString("hex")}`;
    const timestamp = iso(now);
    try {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO principals(id,name,kind,status,created_at,updated_at)
             VALUES (?,?,?,'active',?,?)`,
          )
          .run(principalId, name, kind, timestamp, timestamp);
        this.db
          .query(
            `INSERT INTO credentials(id,principal_id,secret_hash,status,created_at)
             VALUES (?,?,?,'active',?)`,
          )
          .run(credentialId, principalId, digest(credential), timestamp);
      })();
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new TransportError(409, "principal_exists", "principal already exists");
      }
      throw error;
    }
    return {
      principal: {
        id: principalId,
        name,
        kind,
        status: "active",
        created_at: timestamp,
        updated_at: timestamp,
      },
      credential_id: credentialId,
      credential,
    };
  }

  issueCredential(
    principalName: string,
    now = Date.now(),
  ): { principal: string; credential_id: string; credential: string } {
    const principal = this.db
      .query("SELECT id,name FROM principals WHERE name=? AND status='active'")
      .get(principalName) as { id: string; name: string } | null;
    if (!principal) {
      throw new TransportError(404, "principal_not_found", "principal not found");
    }
    const credentialId = randomUUID();
    const credential = `mtk_${credentialId}.${randomBytes(32).toString("hex")}`;
    this.db
      .query(
        `INSERT INTO credentials(id,principal_id,secret_hash,status,created_at)
         VALUES (?,?,?,'active',?)`,
      )
      .run(credentialId, principal.id, digest(credential), iso(now));
    return {
      principal: principal.name,
      credential_id: credentialId,
      credential,
    };
  }

  revokeCredential(credentialId: string, now = Date.now()): void {
    const result = this.db
      .query(
        `UPDATE credentials SET status='revoked',revoked_at=?
         WHERE id=? AND status='active'`,
      )
      .run(iso(now), credentialId);
    if (result.changes === 0) {
      throw new TransportError(
        404,
        "credential_not_found",
        "active credential not found",
      );
    }
  }

  revokePrincipal(name: string, now = Date.now()): void {
    const result = this.db
      .query("UPDATE principals SET status='revoked',updated_at=? WHERE name=?")
      .run(iso(now), name);
    if (result.changes === 0) {
      throw new TransportError(404, "principal_not_found", "principal not found");
    }
    this.db
      .query(
        `UPDATE credentials SET status='revoked',revoked_at=?
         WHERE principal_id=(SELECT id FROM principals WHERE name=?)`,
      )
      .run(iso(now), name);
  }

  authenticate(credential: string): AuthenticatedPrincipal | null {
    if (!credential.startsWith("mtk_") || credential.length > 256) return null;
    const separator = credential.indexOf(".");
    if (separator === -1) return null;
    const credentialId = credential.slice(4, separator);
    if (!/^[0-9a-f-]{36}$/.test(credentialId)) return null;
    const candidate = digest(credential);
    const row = this.db
      .query(
        `SELECT p.*, c.id AS credential_id, c.secret_hash
         FROM credentials c JOIN principals p ON p.id=c.principal_id
         WHERE c.id=? AND c.status='active' AND p.status='active'`,
      )
      .get(credentialId) as
      | (Principal & { credential_id: string; secret_hash: Uint8Array })
      | null;
    if (row && equalDigest(candidate, Buffer.from(row.secret_hash))) {
      const { secret_hash: _secretHash, ...principal } = row;
      return principal;
    }
    return null;
  }

  listPrincipals(): Principal[] {
    return this.db
      .query(
        "SELECT id,name,kind,status,created_at,updated_at FROM principals ORDER BY name",
      )
      .all() as Principal[];
  }

  createChannel(
    actor: AuthenticatedPrincipal,
    name: string,
    memberNames: string[],
    now = Date.now(),
  ): { id: string; name: string; members: string[] } {
    if (!principalPattern.test(name)) {
      throw new TransportError(400, "invalid_channel", "invalid channel name");
    }
    const uniqueNames = [...new Set([actor.name, ...memberNames])];
    if (uniqueNames.length > 100) {
      throw new TransportError(
        400,
        "too_many_channel_members",
        "channels support at most 100 members",
      );
    }
    const members = uniqueNames.map((memberName) => {
      const principal = this.db
        .query("SELECT id,name FROM principals WHERE name=? AND status='active'")
        .get(memberName) as { id: string; name: string } | null;
      if (!principal) {
        throw new TransportError(
          404,
          "principal_not_found",
          `principal not found: ${memberName}`,
        );
      }
      return principal;
    });
    const channelId = randomUUID();
    const timestamp = iso(now);
    try {
      this.db.transaction(() => {
        this.db
          .query(
            "INSERT INTO channels(id,name,created_by,created_at) VALUES (?,?,?,?)",
          )
          .run(channelId, name, actor.id, timestamp);
        const insert = this.db.query(
          `INSERT INTO channel_members(channel_id,principal_id,can_send,created_at)
           VALUES (?,?,1,?)`,
        );
        for (const member of members) insert.run(channelId, member.id, timestamp);
      })();
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new TransportError(409, "channel_exists", "channel already exists");
      }
      throw error;
    }
    return { id: channelId, name, members: members.map((member) => member.name) };
  }

  listChannels(actor: AuthenticatedPrincipal): Array<Record<string, unknown>> {
    return this.db
      .query(
        `SELECT c.id,c.name,owner.name AS owner,cm.can_send,c.created_at
         FROM channel_members cm
         JOIN channels c ON c.id=cm.channel_id
         JOIN principals owner ON owner.id=c.created_by
         WHERE cm.principal_id=?
         ORDER BY c.name`,
      )
      .all(actor.id) as Array<Record<string, unknown>>;
  }

  setChannelMember(
    actor: AuthenticatedPrincipal,
    channelName: string,
    principalName: string,
    canSend: boolean,
    now = Date.now(),
  ): void {
    const channel = this.db
      .query("SELECT id,created_by FROM channels WHERE name=?")
      .get(channelName) as { id: string; created_by: string } | null;
    if (!channel || channel.created_by !== actor.id) {
      throw new TransportError(404, "channel_not_found", "channel not found");
    }
    const member = this.db
      .query("SELECT id FROM principals WHERE name=? AND status='active'")
      .get(principalName) as { id: string } | null;
    if (!member) {
      throw new TransportError(404, "principal_not_found", "principal not found");
    }
    const membership = this.db
      .query(
        `SELECT
           EXISTS(SELECT 1 FROM channel_members WHERE channel_id=? AND principal_id=?)
             AS present,
           (SELECT COUNT(*) FROM channel_members WHERE channel_id=?) AS member_count`,
      )
      .get(channel.id, member.id, channel.id) as {
      present: number;
      member_count: number;
    };
    if (!membership.present && membership.member_count >= 100) {
      throw new TransportError(
        409,
        "channel_full",
        "channel supports at most 100 members",
      );
    }
    this.db
      .query(
        `INSERT INTO channel_members(channel_id,principal_id,can_send,created_at)
         VALUES (?,?,?,?)
         ON CONFLICT(channel_id,principal_id)
         DO UPDATE SET can_send=excluded.can_send`,
      )
      .run(channel.id, member.id, canSend ? 1 : 0, iso(now));
  }

  removeChannelMember(
    actor: AuthenticatedPrincipal,
    channelName: string,
    principalName: string,
  ): void {
    const channel = this.db
      .query("SELECT id,created_by FROM channels WHERE name=?")
      .get(channelName) as { id: string; created_by: string } | null;
    if (!channel || channel.created_by !== actor.id) {
      throw new TransportError(404, "channel_not_found", "channel not found");
    }
    const member = this.db
      .query("SELECT id FROM principals WHERE name=?")
      .get(principalName) as { id: string } | null;
    if (!member) {
      throw new TransportError(404, "principal_not_found", "principal not found");
    }
    if (member.id === channel.created_by) {
      throw new TransportError(
        409,
        "channel_owner_required",
        "channel owner cannot be removed",
      );
    }
    const result = this.db
      .query(
        "DELETE FROM channel_members WHERE channel_id=? AND principal_id=?",
      )
      .run(channel.id, member.id);
    if (result.changes === 0) {
      throw new TransportError(
        404,
        "channel_member_not_found",
        "channel member not found",
      );
    }
  }

  send(
    sender: AuthenticatedPrincipal,
    idempotencyKey: string,
    input: SendInput,
    now = Date.now(),
  ): {
    message_id: string;
    delivery_ids: string[];
    duplicate: boolean;
    created_at: string;
  } {
    if (!idempotencyPattern.test(idempotencyKey)) {
      throw new TransportError(
        400,
        "invalid_idempotency_key",
        "invalid Idempotency-Key",
      );
    }
    if (
      !input ||
      !input.to ||
      !["principal", "channel"].includes(input.to.kind) ||
      !principalPattern.test(input.to.name) ||
      typeof input.payload !== "string"
    ) {
      throw new TransportError(400, "invalid_message", "invalid message input");
    }
    if (Buffer.byteLength(input.payload) > MAX_PAYLOAD_BYTES) {
      throw new TransportError(413, "payload_too_large", "payload exceeds 1 MiB");
    }
    if (
      input.attributes !== undefined &&
      (typeof input.attributes !== "object" ||
        input.attributes === null ||
        Array.isArray(input.attributes))
    ) {
      throw new TransportError(
        400,
        "invalid_attributes",
        "attributes must be an object",
      );
    }
    let attributesJson: string | null;
    try {
      attributesJson =
        input.attributes === undefined ? null : JSON.stringify(input.attributes);
    } catch {
      throw new TransportError(
        400,
        "invalid_attributes",
        "attributes must be JSON serializable",
      );
    }
    if (attributesJson && Buffer.byteLength(attributesJson) > MAX_ATTRIBUTES_BYTES) {
      throw new TransportError(
        413,
        "attributes_too_large",
        "attributes exceed 16 KiB",
      );
    }
    if (
      input.content_type !== undefined &&
      (typeof input.content_type !== "string" ||
        input.content_type.length < 1 ||
        input.content_type.length > 255)
    ) {
      throw new TransportError(
        400,
        "invalid_content_type",
        "content_type must be between 1 and 255 characters",
      );
    }
    if (input.reply_to !== undefined) {
      if (
        typeof input.reply_to !== "string" ||
        input.reply_to.length < 1 ||
        input.reply_to.length > 128
      ) {
        throw new TransportError(
          400,
          "invalid_reply_to",
          "reply_to must be a valid message ID",
        );
      }
      const visibleParent = this.db
        .query(
          `SELECT 1
           FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id
           WHERE m.id=? AND (m.sender_id=? OR d.recipient_id=?)
           LIMIT 1`,
        )
        .get(input.reply_to, sender.id, sender.id);
      if (!visibleParent) {
        throw new TransportError(
          404,
          "reply_message_not_found",
          "reply message not found",
        );
      }
    }
    const maxAttempts = input.max_attempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new TransportError(
        400,
        "invalid_max_attempts",
        "max_attempts must be between 1 and 100",
      );
    }
    const inputHash = stableInputHash(sender.id, input);
    const existing = this.db
      .query(
        `SELECT id,input_hash,created_at FROM messages
         WHERE sender_id=? AND idempotency_key=?`,
      )
      .get(sender.id, idempotencyKey) as
      | { id: string; input_hash: string; created_at: string }
      | null;
    if (existing) {
      if (existing.input_hash !== inputHash) {
        throw new TransportError(
          409,
          "idempotency_conflict",
          "Idempotency-Key was reused with different input",
        );
      }
      const deliveryIds = this.db
        .query("SELECT id FROM deliveries WHERE message_id=? ORDER BY ordinal")
        .all(existing.id) as Array<{ id: string }>;
      return {
        message_id: existing.id,
        delivery_ids: deliveryIds.map((row) => row.id),
        duplicate: true,
        created_at: existing.created_at,
      };
    }

    let routeId: string;
    let recipients: Array<{ id: string; name: string }>;
    if (input.to.kind === "principal") {
      const recipient = this.db
        .query("SELECT id,name FROM principals WHERE name=? AND status='active'")
        .get(input.to.name) as { id: string; name: string } | null;
      if (!recipient) {
        throw new TransportError(404, "recipient_not_found", "recipient not found");
      }
      routeId = recipient.id;
      recipients = [recipient];
    } else {
      const channel = this.db
        .query(
          `SELECT c.id,
             EXISTS(
               SELECT 1 FROM channel_members cm
               WHERE cm.channel_id=c.id AND cm.principal_id=? AND cm.can_send=1
             ) AS can_send
           FROM channels c WHERE c.name=?`,
        )
        .get(sender.id, input.to.name) as { id: string; can_send: number } | null;
      if (!channel) {
        throw new TransportError(404, "channel_not_found", "channel not found");
      }
      if (!channel.can_send) {
        throw new TransportError(403, "channel_forbidden", "channel send forbidden");
      }
      routeId = channel.id;
      recipients = this.db
        .query(
          `SELECT p.id,p.name
           FROM channel_members cm JOIN principals p ON p.id=cm.principal_id
           WHERE cm.channel_id=? AND p.status='active' AND p.id<>?
           ORDER BY p.name`,
        )
        .all(channel.id, sender.id) as Array<{ id: string; name: string }>;
      if (recipients.length === 0) {
        throw new TransportError(
          409,
          "channel_has_no_recipients",
          "channel has no other active recipients",
        );
      }
    }

    const messageId = randomUUID();
    const timestamp = iso(now);
    const deliveryIds: string[] = [];
    try {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO messages(
               id,sender_id,route_kind,route_id,payload,content_type,attributes_json,
               reply_to,idempotency_key,input_hash,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            messageId,
            sender.id,
            input.to.kind,
            routeId,
            input.payload,
            input.content_type ?? "text/plain",
            attributesJson,
            input.reply_to ?? null,
            idempotencyKey,
            inputHash,
            timestamp,
          );
        const insert = this.db.query(
          `INSERT INTO deliveries(
             id,message_id,recipient_id,ordinal,state,available_at,attempt_count,
             max_attempts,created_at
           ) VALUES (?,?,?,?,'queued',?,0,?,?)`,
        );
        recipients.forEach((recipient, ordinal) => {
          const deliveryId = randomUUID();
          insert.run(
            deliveryId,
            messageId,
            recipient.id,
            ordinal,
            timestamp,
            maxAttempts,
            timestamp,
          );
          deliveryIds.push(deliveryId);
        });
      }).immediate();
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      const raced = this.db
        .query(
          `SELECT id,input_hash,created_at FROM messages
           WHERE sender_id=? AND idempotency_key=?`,
        )
        .get(sender.id, idempotencyKey) as
        | { id: string; input_hash: string; created_at: string }
        | null;
      if (!raced || raced.input_hash !== inputHash) {
        throw new TransportError(
          409,
          "idempotency_conflict",
          "Idempotency-Key was reused with different input",
        );
      }
      const racedDeliveries = this.db
        .query("SELECT id FROM deliveries WHERE message_id=? ORDER BY ordinal")
        .all(raced.id) as Array<{ id: string }>;
      return {
        message_id: raced.id,
        delivery_ids: racedDeliveries.map((row) => row.id),
        duplicate: true,
        created_at: raced.created_at,
      };
    }
    return {
      message_id: messageId,
      delivery_ids: deliveryIds,
      duplicate: false,
      created_at: timestamp,
    };
  }

  claim(
    recipient: AuthenticatedPrincipal,
    limit = 10,
    leaseSeconds = 60,
    now = Date.now(),
  ): ClaimedDelivery[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TransportError(400, "invalid_limit", "limit must be between 1 and 100");
    }
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 3600
    ) {
      throw new TransportError(
        400,
        "invalid_lease",
        "lease_seconds must be between 1 and 3600",
      );
    }
    const nowIso = iso(now);
    const leaseExpiresAt = iso(now + leaseSeconds * 1000);
    const claimed: ClaimedDelivery[] = [];
    this.reapExpired(now, recipient.id);
    this.db.transaction(() => {
      const candidates = this.db
        .query(
          `SELECT d.id AS delivery_id,
                  length(CAST(m.payload AS BLOB)) AS payload_bytes,
                  length(CAST(COALESCE(m.attributes_json,'') AS BLOB)) AS attributes_bytes
           FROM deliveries d
           JOIN messages m ON m.id=d.message_id
           WHERE d.recipient_id=? AND d.state='queued' AND d.available_at<=?
           ORDER BY d.available_at,m.created_at,d.id
           LIMIT ?`,
        )
        .all(recipient.id, nowIso, limit) as Array<{
          delivery_id: string;
          payload_bytes: number;
          attributes_bytes: number;
        }>;
      let claimedBytes = 0;
      for (const candidate of candidates) {
        const rowBytes =
          candidate.payload_bytes + candidate.attributes_bytes + 1024;
        if (claimed.length > 0 && claimedBytes + rowBytes > MAX_CLAIM_BYTES) {
          break;
        }
        claimedBytes += rowBytes;
        const row = this.db
          .query(
            `SELECT d.id AS delivery_id,d.message_id,d.attempt_count,
                    m.payload,m.content_type,m.attributes_json,m.reply_to,m.created_at,
                    sender.name AS sender_name,recipient.name AS recipient_name
             FROM deliveries d
             JOIN messages m ON m.id=d.message_id
             JOIN principals sender ON sender.id=m.sender_id
             JOIN principals recipient ON recipient.id=d.recipient_id
             WHERE d.id=? AND d.recipient_id=? AND d.state='queued'`,
          )
          .get(candidate.delivery_id, recipient.id) as {
          delivery_id: string;
          message_id: string;
          attempt_count: number;
          payload: string;
          content_type: string;
          attributes_json: string | null;
          reply_to: string | null;
          created_at: string;
          sender_name: string;
          recipient_name: string;
        } | null;
        if (!row) continue;
        const leaseToken = `mls_${randomBytes(32).toString("hex")}`;
        const attemptCount = row.attempt_count + 1;
        this.db
          .query(
            `UPDATE deliveries SET state='leased',attempt_count=?,lease_owner_id=?,
             lease_token_hash=?,leased_at=?,lease_expires_at=? WHERE id=? AND state='queued'`,
          )
          .run(
            attemptCount,
            recipient.id,
            digest(leaseToken),
            nowIso,
            leaseExpiresAt,
            row.delivery_id,
          );
        this.db
          .query(
            `INSERT INTO delivery_attempts(
               id,delivery_id,attempt_number,principal_id,claimed_at,lease_expires_at
             ) VALUES (?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            row.delivery_id,
            attemptCount,
            recipient.id,
            nowIso,
            leaseExpiresAt,
          );
        claimed.push({
          delivery_id: row.delivery_id,
          message_id: row.message_id,
          from: row.sender_name,
          to: row.recipient_name,
          payload: row.payload,
          content_type: row.content_type,
          attributes: parseJsonRecord(row.attributes_json),
          reply_to: row.reply_to,
          created_at: row.created_at,
          attempt_count: attemptCount,
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt,
        });
      }
    }).immediate();
    return claimed;
  }

  reapExpired(now = Date.now(), recipientId?: string): number {
    const nowIso = iso(now);
    let reaped = 0;
    this.db.transaction(() => {
      const expired = this.db
        .query(
          `SELECT id,attempt_count,max_attempts FROM deliveries
           WHERE state='leased' AND lease_expires_at<=?
             ${recipientId ? "AND recipient_id=?" : ""}`,
        )
        .all(nowIso, ...(recipientId ? [recipientId] : [])) as Array<{
        id: string;
        attempt_count: number;
        max_attempts: number;
      }>;
      for (const delivery of expired) {
        const isDead = delivery.attempt_count >= delivery.max_attempts;
        const update = this.db
          .query(
            `UPDATE deliveries SET
               state=?,available_at=?,lease_owner_id=NULL,lease_token_hash=NULL,
               leased_at=NULL,lease_expires_at=NULL,dead_lettered_at=?,
               last_error_code='lease_expired'
             WHERE id=? AND state='leased' AND lease_expires_at<=?`,
          )
          .run(
            isDead ? "dead_letter" : "queued",
            nowIso,
            isDead ? nowIso : null,
            delivery.id,
            nowIso,
          );
        if (update.changes !== 1) continue;
        reaped++;
        this.db
          .query(
            `UPDATE delivery_attempts SET finished_at=?,outcome=?,reason_code='lease_expired'
             WHERE delivery_id=? AND attempt_number=? AND finished_at IS NULL`,
          )
          .run(
            nowIso,
            isDead ? "dead_letter" : "expired",
            delivery.id,
            delivery.attempt_count,
          );
      }
    }).immediate();
    return reaped;
  }

  private getLease(
    recipient: AuthenticatedPrincipal,
    deliveryId: string,
    leaseToken: string,
    nowIso: string,
  ): {
    state: DeliveryState | "discarded";
    attempt_count: number;
    max_attempts: number;
    lease_token_hash: Uint8Array | null;
    lease_expires_at: string | null;
    acknowledged_at: string | null;
  } {
    const delivery = this.db
      .query(
        `SELECT state,attempt_count,max_attempts,lease_token_hash,lease_expires_at,acknowledged_at
         FROM deliveries WHERE id=? AND recipient_id=?`,
      )
      .get(deliveryId, recipient.id) as {
      state: DeliveryState | "discarded";
      attempt_count: number;
      max_attempts: number;
      lease_token_hash: Uint8Array | null;
      lease_expires_at: string | null;
      acknowledged_at: string | null;
    } | null;
    if (!delivery) {
      throw new TransportError(404, "delivery_not_found", "delivery not found");
    }
    if (
      delivery.state === "acknowledged" &&
      delivery.lease_token_hash &&
      equalDigest(digest(leaseToken), Buffer.from(delivery.lease_token_hash))
    ) {
      return delivery;
    }
    if (
      delivery.state !== "leased" ||
      !delivery.lease_token_hash ||
      !delivery.lease_expires_at ||
      delivery.lease_expires_at <= nowIso ||
      !equalDigest(digest(leaseToken), Buffer.from(delivery.lease_token_hash))
    ) {
      throw new TransportError(409, "stale_lease", "lease is not active");
    }
    return delivery;
  }

  acknowledge(
    recipient: AuthenticatedPrincipal,
    deliveryId: string,
    leaseToken: string,
    now = Date.now(),
  ): { state: "acknowledged"; acknowledged_at: string } {
    const timestamp = iso(now);
    let result: { state: "acknowledged"; acknowledged_at: string } | undefined;
    this.db.transaction(() => {
      const delivery = this.getLease(
        recipient,
        deliveryId,
        leaseToken,
        timestamp,
      );
      if (delivery.state === "acknowledged") {
        result = {
          state: "acknowledged",
          acknowledged_at: delivery.acknowledged_at!,
        };
        return;
      }
      const update = this.db
        .query(
          `UPDATE deliveries SET state='acknowledged',acknowledged_at=?,
           lease_expires_at=NULL
           WHERE id=? AND recipient_id=? AND state='leased' AND lease_expires_at>?`,
        )
        .run(timestamp, deliveryId, recipient.id, timestamp);
      if (update.changes !== 1) {
        throw new TransportError(409, "stale_lease", "lease is not active");
      }
      this.db
        .query(
          `UPDATE delivery_attempts SET finished_at=?,outcome='acknowledged'
           WHERE delivery_id=? AND attempt_number=?`,
        )
        .run(timestamp, deliveryId, delivery.attempt_count);
      result = { state: "acknowledged", acknowledged_at: timestamp };
    }).immediate();
    return result!;
  }

  nack(
    recipient: AuthenticatedPrincipal,
    deliveryId: string,
    leaseToken: string,
    retryAfterSeconds: number | undefined,
    reasonCode: string | undefined,
    now = Date.now(),
  ): { state: "queued" | "dead_letter"; available_at: string | null } {
    const boundedReason =
      reasonCode && /^[A-Za-z0-9._-]{1,64}$/.test(reasonCode)
        ? reasonCode
        : "rejected";
    const timestamp = iso(now);
    let result:
      | { state: "queued" | "dead_letter"; available_at: string | null }
      | undefined;
    this.db.transaction(() => {
      const delivery = this.getLease(
        recipient,
        deliveryId,
        leaseToken,
        timestamp,
      );
      if (delivery.state !== "leased") {
        throw new TransportError(409, "stale_lease", "lease is not active");
      }
      const dead = delivery.attempt_count >= delivery.max_attempts;
      const delay =
        retryAfterSeconds === undefined
          ? Math.min(300, 2 ** Math.min(delivery.attempt_count, 8))
          : retryAfterSeconds;
      if (!Number.isInteger(delay) || delay < 0 || delay > 86400) {
        throw new TransportError(
          400,
          "invalid_retry_delay",
          "retry_after_seconds must be between 0 and 86400",
        );
      }
      const availableAt = dead ? null : iso(now + delay * 1000);
      const update = this.db
        .query(
          `UPDATE deliveries SET state=?,available_at=?,lease_owner_id=NULL,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,
           dead_lettered_at=?,last_error_code=?
           WHERE id=? AND recipient_id=? AND state='leased' AND lease_expires_at>?`,
        )
        .run(
          dead ? "dead_letter" : "queued",
          availableAt ?? timestamp,
          dead ? timestamp : null,
          boundedReason,
          deliveryId,
          recipient.id,
          timestamp,
        );
      if (update.changes !== 1) {
        throw new TransportError(409, "stale_lease", "lease is not active");
      }
      this.db
        .query(
          `UPDATE delivery_attempts SET finished_at=?,outcome=?,reason_code=?
           WHERE delivery_id=? AND attempt_number=?`,
        )
        .run(
          timestamp,
          dead ? "dead_letter" : "rejected",
          boundedReason,
          deliveryId,
          delivery.attempt_count,
        );
      result = {
        state: dead ? "dead_letter" : "queued",
        available_at: availableAt,
      };
    }).immediate();
    return result!;
  }

  getMessage(actor: AuthenticatedPrincipal, messageId: string): unknown {
    const message = this.db
      .query(
        `SELECT m.id AS message_id,sender.name AS sender,m.payload,m.content_type,
                m.attributes_json,m.reply_to,m.created_at,
                d.id AS delivery_id,recipient.name AS recipient,d.state,
                d.attempt_count,d.lease_expires_at,d.acknowledged_at,d.dead_lettered_at
         FROM messages m
         JOIN principals sender ON sender.id=m.sender_id
         JOIN deliveries d ON d.message_id=m.id
         JOIN principals recipient ON recipient.id=d.recipient_id
         WHERE m.id=? AND (m.sender_id=? OR d.recipient_id=?)
         ORDER BY d.id`,
      )
      .all(messageId, actor.id, actor.id) as Array<Record<string, unknown>>;
    if (message.length === 0) {
      throw new TransportError(404, "message_not_found", "message not found");
    }
    return {
      message_id: messageId,
      sender: message[0].sender,
      payload: message[0].payload,
      content_type: message[0].content_type,
      attributes: parseJsonRecord(message[0].attributes_json as string | null),
      reply_to: message[0].reply_to,
      created_at: message[0].created_at,
      deliveries: message.map(
        ({
          delivery_id,
          recipient,
          state,
          attempt_count,
          lease_expires_at,
          acknowledged_at,
          dead_lettered_at,
        }) => ({
          delivery_id,
          recipient,
          state,
          attempt_count,
          lease_expires_at,
          acknowledged_at,
          dead_lettered_at,
        }),
      ),
    };
  }

  history(
    actor: AuthenticatedPrincipal,
    limit = 50,
    cursor?: string,
  ): { items: Array<Record<string, unknown>>; next_cursor: string | null } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TransportError(400, "invalid_limit", "limit must be between 1 and 100");
    }
    let cursorCreatedAt: string | null = null;
    let cursorDeliveryId: string | null = null;
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          typeof decoded[0] !== "string" ||
          typeof decoded[1] !== "string"
        ) {
          throw new Error("invalid cursor");
        }
        [cursorCreatedAt, cursorDeliveryId] = decoded;
      } catch {
        throw new TransportError(400, "invalid_cursor", "cursor is invalid");
      }
    }
    const rows = this.db
      .query(
        `SELECT m.id AS message_id,d.id AS delivery_id,sender.name AS sender,
                recipient.name AS recipient,m.payload,m.content_type,
                m.attributes_json,m.reply_to,m.created_at,d.state,d.attempt_count,
                d.lease_expires_at,d.acknowledged_at,d.dead_lettered_at
         FROM messages m
         JOIN principals sender ON sender.id=m.sender_id
         JOIN deliveries d ON d.message_id=m.id
         JOIN principals recipient ON recipient.id=d.recipient_id
         WHERE (m.sender_id=? OR d.recipient_id=?)
           AND (? IS NULL OR m.created_at<? OR (m.created_at=? AND d.id<?))
         ORDER BY m.created_at DESC,d.id DESC
         LIMIT ?`,
      )
      .all(
        actor.id,
        actor.id,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorDeliveryId,
        limit + 1,
      ) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit).map((row) => ({
      ...row,
      attributes: parseJsonRecord(row.attributes_json as string | null),
      attributes_json: undefined,
    }));
    const last = visible.at(-1) as Record<string, unknown> | undefined;
    const lastCreatedAt = last?.created_at as string | undefined;
    const lastDeliveryId = last?.delivery_id as string | undefined;
    return {
      items: visible,
      next_cursor:
        hasMore && lastCreatedAt && lastDeliveryId
          ? Buffer.from(
              JSON.stringify([lastCreatedAt, lastDeliveryId]),
            ).toString("base64url")
          : null,
    };
  }

  deleteMessage(actor: AuthenticatedPrincipal, messageId: string): void {
    const message = this.db
      .query(
        `SELECT m.sender_id,
           SUM(CASE WHEN d.state NOT IN ('acknowledged','discarded') THEN 1 ELSE 0 END)
             AS blocking_deliveries
         FROM messages m JOIN deliveries d ON d.message_id=m.id
         WHERE m.id=?
         GROUP BY m.id`,
      )
      .get(messageId) as
      | { sender_id: string; blocking_deliveries: number }
      | null;
    if (!message || message.sender_id !== actor.id) {
      throw new TransportError(404, "message_not_found", "message not found");
    }
    if (message.blocking_deliveries > 0) {
      throw new TransportError(
        409,
        "message_not_terminal",
        "all deliveries must be acknowledged or discarded before deletion",
      );
    }
    const referenced = this.db
      .query("SELECT 1 FROM messages WHERE reply_to=? LIMIT 1")
      .get(messageId);
    if (referenced) {
      throw new TransportError(
        409,
        "message_is_referenced",
        "message cannot be deleted while another message replies to it",
      );
    }
    this.db.query("DELETE FROM messages WHERE id=?").run(messageId);
  }

  retainTerminalBefore(before: string, limit = 1_000): number {
    if (!isStrictIsoTimestamp(before)) {
      throw new TransportError(
        400,
        "invalid_retention_time",
        "before must be an ISO timestamp",
      );
    }
    const beforeDate = new Date(before);
    const canonicalBefore = beforeDate.toISOString();
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TransportError(
        400,
        "invalid_limit",
        "limit must be between 1 and 10000",
      );
    }
    this.reapExpired();
    const candidates = this.db
      .query(
        `SELECT m.id
         FROM messages m JOIN deliveries d ON d.message_id=m.id
         WHERE m.created_at<?
           AND NOT EXISTS(SELECT 1 FROM messages child WHERE child.reply_to=m.id)
         GROUP BY m.id
         HAVING SUM(CASE WHEN d.state NOT IN ('acknowledged','discarded')
                         THEN 1 ELSE 0 END)=0
         ORDER BY m.created_at,m.id
         LIMIT ?`,
      )
      .all(canonicalBefore, limit) as Array<{ id: string }>;
    this.db.transaction(() => {
      const remove = this.db.query("DELETE FROM messages WHERE id=?");
      for (const candidate of candidates) remove.run(candidate.id);
    }).immediate();
    return candidates.length;
  }

  deadLetters(
    actor?: AuthenticatedPrincipal,
    now = Date.now(),
  ): Array<Record<string, unknown>> {
    this.reapExpired(now, actor?.id);
    const where = actor
      ? "WHERE d.recipient_id=? AND d.state='dead_letter'"
      : "WHERE d.state='dead_letter'";
    return this.db
      .query(
        `SELECT d.id AS delivery_id,d.message_id,s.name AS sender,r.name AS recipient,
                d.attempt_count,d.max_attempts,d.dead_lettered_at,d.last_error_code
         FROM deliveries d
         JOIN messages m ON m.id=d.message_id
         JOIN principals s ON s.id=m.sender_id
         JOIN principals r ON r.id=d.recipient_id
         ${where}
         ORDER BY d.dead_lettered_at,d.id`,
      )
      .all(...(actor ? [actor.id] : [])) as Array<Record<string, unknown>>;
  }

  retryDeadLetter(deliveryId: string, now = Date.now()): void {
    this.reapExpired(now);
    const result = this.db
      .query(
        `UPDATE deliveries SET state='queued',available_at=?,
         max_attempts=attempt_count+max_attempts,
         dead_lettered_at=NULL,last_error_code=NULL WHERE id=? AND state='dead_letter'`,
      )
      .run(iso(now), deliveryId);
    if (result.changes === 0) {
      throw new TransportError(404, "dead_letter_not_found", "dead letter not found");
    }
  }

  discardDeadLetter(deliveryId: string, now = Date.now()): void {
    this.reapExpired(now);
    const result = this.db
      .query(
        `UPDATE deliveries SET state='discarded',discarded_at=?
         WHERE id=? AND state='dead_letter'`,
      )
      .run(iso(now), deliveryId);
    if (result.changes === 0) {
      throw new TransportError(404, "dead_letter_not_found", "dead letter not found");
    }
  }

  metrics(
    actor?: AuthenticatedPrincipal,
    now = Date.now(),
  ): Record<string, number> {
    const nowIso = iso(now);
    const scope = actor ? "AND recipient_id=?" : "";
    const scopeArguments = actor ? [actor.id] : [];
    const derived = this.db
      .query(
        `SELECT
           SUM(CASE WHEN state='queued'
                     OR (state='leased' AND lease_expires_at<=? AND attempt_count<max_attempts)
                    THEN 1 ELSE 0 END) AS queue_depth,
           SUM(CASE WHEN state='leased' AND lease_expires_at>? THEN 1 ELSE 0 END) AS active_leases,
           SUM(CASE WHEN state='acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
           SUM(CASE WHEN state='dead_letter'
                     OR (state='leased' AND lease_expires_at<=? AND attempt_count>=max_attempts)
                    THEN 1 ELSE 0 END) AS dead_letters,
           SUM(CASE WHEN state='discarded' THEN 1 ELSE 0 END) AS discarded
         FROM deliveries WHERE 1=1 ${scope}`,
      )
      .get(nowIso, nowIso, nowIso, ...scopeArguments) as Record<
      string,
      number | null
    >;
    const oldest = this.db
      .query(
        `SELECT created_at FROM deliveries
         WHERE (state='queued'
                OR (state='leased' AND lease_expires_at<=? AND attempt_count<max_attempts))
           ${scope}
         ORDER BY created_at LIMIT 1`,
      )
      .get(nowIso, ...scopeArguments) as { created_at: string } | null;
    const retries = this.db
      .query(
        `SELECT COUNT(*) AS count
         FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
         WHERE a.attempt_number>1 ${actor ? "AND d.recipient_id=?" : ""}`,
      )
      .get(...scopeArguments) as { count: number };
    const latency = this.db
      .query(
        `SELECT AVG((julianday(acknowledged_at)-julianday(created_at))*86400000.0) AS value
         FROM deliveries WHERE state='acknowledged' ${scope}`,
      )
      .get(...scopeArguments) as { value: number | null };
    return {
      queue_depth: derived.queue_depth ?? 0,
      active_leases: derived.active_leases ?? 0,
      acknowledged: derived.acknowledged ?? 0,
      dead_letters: derived.dead_letters ?? 0,
      discarded: derived.discarded ?? 0,
      retries: retries.count,
      oldest_message_age_ms: oldest
        ? Math.max(0, now - new Date(oldest.created_at).getTime())
        : 0,
      average_delivery_latency_ms: Math.max(0, latency.value ?? 0),
    };
  }
}

import { createHash, randomBytes, randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { MeshtermClient, MeshtermClientError, MeshtermClaimTimeoutError, type ClaimedDelivery, type WaitForDeliveryOptions } from "../../packages/client";

export class AgentError extends Error {}
export function safeMessage(error: unknown): string {
  if (error instanceof MeshtermClaimTimeoutError) return error.message;
  if (error instanceof AgentError) return error.message;
  if (error instanceof MeshtermClientError && error.status === 404) {
    try {
      if (JSON.parse(error.responseBody)?.error?.code === "recipient_not_found") {
        return "Recipient name not found. Set the 'to' argument to the exact name field from mesh_peers, not its id/UUID. Correct the recipient before retrying.";
      }
    } catch { /* Never expose an unrecognized server response body. */ }
  }
  if (error instanceof MeshtermClientError) return `Meshterm HTTP ${error.status}; check the session credential and delivery lease.`;
  return "Meshterm operation failed; check setup and session state. No acknowledgement was assumed.";
}

export const agentHome = () => process.env.MESHTERM_AGENT_HOME ?? join(homedir(), ".meshterm", "agents");
export type Principal = { id: string; name: string; kind: string; status: string };
export type Delivery = Omit<ClaimedDelivery, "lease_token">;
type Registration = { server: string; credential: string };
type SavedSession = { host: string; sessionId: string; label: string; registrationKey: string; server: string; credential: string; principal?: Principal };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export function privateRead<T>(path: string): T {
  if (!existsSync(path)) throw new AgentError("Meshterm configuration is missing; run meshterm-agent setup or register this session first.");
  if ((statSync(path).mode & 0o077) !== 0) throw new AgentError("Meshterm credential file must have mode 0600");
  return read<T>(path);
}
export function privateWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
export function installRegistration(home: string, config: Registration): void {
  const url = new URL(config.server);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new AgentError("Registration requires HTTPS or loopback HTTP");
  }
  if (!config.credential.startsWith("mtrg_")) throw new AgentError("Expected a scoped registration grant");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  privateWrite(join(home, "registration.json"), { server: url.origin, credential: config.credential });
}
async function registrationRequest<T>(config: Registration, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.server}/v1/registrations`, {
    ...init, signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${config.credential}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new AgentError(`Meshterm registration HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
export async function directory(home = agentHome()): Promise<Principal[]> {
  const config = privateRead<Registration>(join(home, "registration.json"));
  const result = await registrationRequest<{ principals: Principal[] }>(config);
  return result.principals;
}

// Stable session IDs come from the host. Forks must pass a new ID.
export async function ensureSession(options: { host: string; sessionId: string; label: string; home?: string }): Promise<AgentSession> {
  const home = options.home ?? agentHome();
  if (!options.host || !options.sessionId || options.sessionId.length > 1024 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(options.label)) {
    throw new AgentError("A host, session ID, and safe label (1-32 characters) are required");
  }
  const key = createHash("sha256").update(JSON.stringify([options.host, options.sessionId])).digest("hex");
  const path = join(home, "sessions", key);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const savedPath = join(path, "session.json");
  if (!existsSync(savedPath)) {
    const registration = privateRead<Registration>(join(home, "registration.json"));
    const saved: SavedSession = { ...options, registrationKey: randomUUID(), server: registration.server, credential: `mtk_${randomUUID()}.${randomBytes(32).toString("hex")}` };
    try { writeFileSync(savedPath, JSON.stringify(saved) + "\n", { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  let saved = privateRead<SavedSession>(savedPath);
  if (!saved.principal) {
    const registration = privateRead<Registration>(join(home, "registration.json"));
    if (registration.server !== saved.server) throw new AgentError("Registration server changed; resume with the original registration");
    const result = await registrationRequest<{ principal: Principal }>(registration, {
      method: "POST", body: JSON.stringify({ registration_key: saved.registrationKey, label: saved.label, credential: saved.credential }),
    });
    saved = { ...saved, principal: result.principal };
    privateWrite(savedPath, saved);
  }
  return new AgentSession(path, saved, home);
}

export function loadSession(path: string, home = agentHome()): AgentSession {
  const saved = privateRead<SavedSession>(join(path, "session.json"));
  if (!saved.principal) throw new AgentError("Session registration is not complete");
  return new AgentSession(path, saved, home);
}

export class AgentSession {
  private operations = new Map<string, Promise<unknown>>();
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.operations.set(id, current);
    try { return await current; } finally { if (this.operations.get(id) === current) this.operations.delete(id); }
  }
  readonly client: MeshtermClient;
  readonly principal: Principal;
  constructor(readonly path: string, saved: SavedSession, readonly home: string) {
    this.client = new MeshtermClient(saved);
    this.principal = saved.principal!;
    mkdirSync(join(path, "deliveries"), { recursive: true, mode: 0o700 });
  }
  private deliveryPath(id: string) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new AgentError("Invalid delivery ID");
    return join(this.path, "deliveries", `${id}.json`);
  }
  private lease(id: string): ClaimedDelivery { return privateRead(this.deliveryPath(id)); }
  private remember(item: ClaimedDelivery): Delivery {
    privateWrite(this.deliveryPath(item.delivery_id), item);
    const { lease_token: _, ...delivery } = item;
    return delivery;
  }
  async identity() { return (await this.client.identity()).principal; }
  async peers() { return directory(this.home); }
  async send(to: string, payload: string, idempotencyKey: string, replyTo?: string) {
    return this.client.send(idempotencyKey, { to: { kind: "principal", name: to }, payload, ...(replyTo ? { reply_to: replyTo } : {}) });
  }
  async wait(options: WaitForDeliveryOptions = {}): Promise<Delivery | null> {
    const release = this.receiverLock();
    try {
      const item = await this.client.waitForDelivery({ leaseSeconds: 120, ...options });
      return item ? this.remember(item) : null;
    } finally { release(); }
  }
  async sendAndWait(to: string, payload: string, idempotencyKey: string, options: WaitForDeliveryOptions = {}) {
    const release = this.receiverLock();
    try {
      const result = await this.client.sendAndWait(idempotencyKey, { to: { kind: "principal", name: to }, payload }, { leaseSeconds: 120, ...options });
      return { receipt: result.receipt, reply: result.reply ? this.remember(result.reply) : null };
    } finally { release(); }
  }
  async ack(id: string) {
    return this.exclusive(id, async () => {
      const item = this.lease(id);
      await this.client.ack(id, item.lease_token);
      unlinkSync(this.deliveryPath(id));
      return { acknowledged: id };
    });
  }
  async nack(id: string) {
    return this.exclusive(id, async () => {
      const item = this.lease(id);
      await this.client.nack(id, item.lease_token, { reasonCode: "agent_rejected", retryAfterSeconds: 1 });
      unlinkSync(this.deliveryPath(id));
      return { rejected: id };
    });
  }
  async reply(id: string, payload: string) {
    return this.exclusive(id, async () => {
      const item = this.lease(id);
      await this.client.renew(id, item.lease_token, 120);
      // Stable key makes a retry safe when sending succeeded but acknowledgement failed.
      const receipt = await this.send(item.from, payload, `reply-${id}`, item.message_id);
      await this.client.ack(id, item.lease_token);
      unlinkSync(this.deliveryPath(id));
      return { receipt, acknowledged: id };
    });
  }
  async renew(id: string) {
    return this.exclusive(id, async () => {
      const item = this.lease(id);
      const result = await this.client.renew(id, item.lease_token, 120);
      privateWrite(this.deliveryPath(id), { ...item, lease_expires_at: result.lease_expires_at });
      return result;
    });
  }
  // Prevent an unfiltered listener from stealing a send-and-wait reply in this session.
  private receiverLock(): () => void {
    const path = join(this.path, "receiver.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
        return () => unlinkSync(path);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(readFileSync(path, "utf8"));
        if (!Number.isInteger(pid) || pid < 1) throw new AgentError("Invalid session receiver lock");
        try { process.kill(pid, 0); }
        catch (error: any) {
          if (error.code === "ESRCH") { unlinkSync(path); continue; }
        }
        throw new AgentError("This session already has a waiting receiver; stop listening before waiting for a reply");
      }
    }
    throw new AgentError("Could not acquire session receiver lock");
  }
}

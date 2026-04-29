import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const ENDPOINT = "https://t.meshterm.live/ping";
const HOME = process.env.HOME ?? "~";
const DIR = join(HOME, ".meshterm");
const ID_FILE = join(DIR, ".telemetry-id");
const CONFIG_FILE = join(DIR, "config.json");

let cachedId: string | null = null;

function isDisabled(): boolean {
  if (process.env.MESHTERM_TELEMETRY === "0") return true;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (cfg.telemetry === false) return true;
  } catch {}
  return false;
}

function getId(): string {
  if (cachedId) return cachedId;
  try {
    cachedId = readFileSync(ID_FILE, "utf-8").trim();
  } catch {
    cachedId = randomUUID();
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(ID_FILE, cachedId);
    } catch {}
  }
  return cachedId!;
}

let msgCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function track(event: string) {
  if (isDisabled()) return;
  const payload = {
    product: "meshterm",
    event,
    version: process.env.MESHTERM_VERSION ?? "unknown",
    id: getId(),
    os: process.platform,
    node: process.versions?.bun ?? process.versions?.node ?? "unknown",
  };
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export function trackMessage() {
  if (isDisabled()) return;
  msgCount++;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      if (msgCount > 0) {
        const payload = {
          product: "meshterm",
          event: "message_sent",
          version: process.env.MESHTERM_VERSION ?? "unknown",
          id: getId(),
          os: process.platform,
          node: process.versions?.bun ?? process.versions?.node ?? "unknown",
          count: msgCount,
        };
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        msgCount = 0;
      }
      flushTimer = null;
    }, 5 * 60 * 1000); // 5 minutes
  }
}

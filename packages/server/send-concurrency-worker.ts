import { TransportStore } from "./transport";

const [databasePath, credential, startAt] = process.argv.slice(2);
const store = new TransportStore(databasePath);
const actor = store.authenticate(credential);
if (!actor) throw new Error("worker authentication failed");
const delay = Number(startAt) - Date.now();
if (delay > 0) await Bun.sleep(delay);
const receipt = store.send(
  actor,
  "concurrent-idempotency-1",
  { to: { kind: "principal", name: "bob" }, payload: "same input" },
  1_000,
);
process.stdout.write(JSON.stringify(receipt));
store.close();

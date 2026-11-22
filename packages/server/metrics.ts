import type { TransportStore } from "./transport";

const fields = [
  {
    key: "queue_depth",
    name: "meshterm_queue_depth",
    help: "Currently queued deliveries",
    divisor: 1,
  },
  {
    key: "active_leases",
    name: "meshterm_active_leases",
    help: "Currently active delivery leases",
    divisor: 1,
  },
  {
    key: "acknowledged",
    name: "meshterm_acknowledged_deliveries",
    help: "Retained acknowledged deliveries",
    divisor: 1,
  },
  {
    key: "dead_letters",
    name: "meshterm_dead_letters",
    help: "Currently dead-letter deliveries",
    divisor: 1,
  },
  {
    key: "discarded",
    name: "meshterm_discarded_deliveries",
    help: "Retained discarded deliveries",
    divisor: 1,
  },
  {
    key: "retries",
    name: "meshterm_retry_attempts",
    help: "Retry attempts for retained deliveries",
    divisor: 1,
  },
  {
    key: "oldest_message_age_ms",
    name: "meshterm_oldest_queued_delivery_age_seconds",
    help: "Age of the oldest currently queued delivery",
    divisor: 1000,
  },
  {
    key: "average_delivery_latency_ms",
    name: "meshterm_average_delivery_latency_seconds",
    help: "Average latency of retained acknowledged deliveries",
    divisor: 1000,
  },
];

export function transportMetricsText(
  metrics: ReturnType<TransportStore["metrics"]>,
): string {
  return fields.map(({ key, name, help, divisor }) => {
    const value = metrics[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("invalid aggregate metrics");
    }
    return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value / divisor}\n`;
  }).join("\n");
}

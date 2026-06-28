import { management } from "./management-client.js";
import { isRunning } from "./cliproxy-manager.js";
import { recordUsage } from "./usage-store.js";

// GET /usage-queue pops-and-removes records, so we drain it on an interval
// and persist what we read via usage-store.js -- otherwise this data is
// gone forever the moment CLIProxyAPI's in-memory queue is read by anyone
// (including, e.g., someone manually curling the endpoint).
const POLL_INTERVAL_MS = 15000;
const DRAIN_BATCH = 50;
const MAX_BATCHES_PER_TICK = 10; // safety cap so a huge backlog can't block the event loop indefinitely

let statisticsEnabled = false;

/** CLIProxyAPI only populates /usage-queue when this toggle is on; flip it on once and remember it. */
async function ensureUsageStatisticsEnabled() {
  if (statisticsEnabled) return;
  try {
    const current = await management.getUsageStatisticsEnabled();
    if (!current?.["usage-statistics-enabled"]) {
      await management.setUsageStatisticsEnabled(true);
    }
    statisticsEnabled = true;
  } catch {
    // CLIProxyAPI not reachable yet, or an older build without this toggle -- retry next tick.
  }
}

async function drainOnce() {
  if (!isRunning()) return;
  await ensureUsageStatisticsEnabled();

  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    let batch;
    try {
      batch = await management.getUsageQueue(DRAIN_BATCH);
    } catch {
      return; // management API not ready (e.g. key not loaded yet) -- try again next tick
    }
    if (!Array.isArray(batch) || batch.length === 0) return;
    recordUsage(batch);
    if (batch.length < DRAIN_BATCH) return; // queue is empty now
  }
}

let started = false;

export function startUsagePoller() {
  if (started) return;
  started = true;
  drainOnce().catch(() => {});
  setInterval(() => drainOnce().catch(() => {}), POLL_INTERVAL_MS);
}

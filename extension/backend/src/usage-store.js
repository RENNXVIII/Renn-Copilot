import fs from "node:fs";
import path from "node:path";
import { settings, ensureDirs } from "./settings.js";

/**
 * Persists per-request token usage drained from CLIProxyAPI's GET
 * /usage-queue (see usage-poller.js). That endpoint pops-and-removes records,
 * so this is the only place that data exists after the fact.
 *
 * Stored at hour granularity (not per-record) so calendar-day summaries
 * (getUsageSummary) can be reconstructed cheaply without re-scanning every
 * raw record.
 *
 * A small ring buffer of the most recent raw records is kept separately for
 * an "activity feed" view, where individual record detail (not just hourly
 * totals) is useful.
 */
function tokensPath() {
  return path.join(settings.cliproxyHome, "usage-tokens.json");
}

const MAX_RECENT = 300;
const MAX_HOURS = 24 * 14; // 14 days of hourly buckets
const FIELDS = ["requests", "failed", "input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "total_tokens"];

function emptyStore() {
  return { hourly: {}, recent: [] };
}

function load() {
  ensureDirs();
  if (!fs.existsSync(tokensPath())) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(tokensPath(), "utf8"));
    // Older builds of this file used `daily` instead of `hourly` -- rather
    // than write a migration for what was, at the time of this change, a
    // few minutes of freshly-collected data, we just start the new shape
    // fresh. recent activity (raw records) carries over fine either way.
    return { hourly: parsed.hourly || {}, recent: parsed.recent || [] };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  ensureDirs();
  fs.writeFileSync(tokensPath(), JSON.stringify(store), "utf8");
}

/** "YYYY-MM-DDTHH" -- truncates an ISO timestamp to the hour. Falls back to now() if missing/unparseable. */
function hourKey(isoTimestamp) {
  const ts = isoTimestamp && !Number.isNaN(Date.parse(isoTimestamp)) ? isoTimestamp : new Date().toISOString();
  return ts.slice(0, 13);
}

function dayOfHourKey(key) {
  return key.slice(0, 10);
}

/** Folds a batch of raw /usage-queue records into the hourly aggregate + recent ring buffer. */
export function recordUsage(records) {
  if (!records?.length) return;
  const store = load();

  for (const r of records) {
    const hour = hourKey(r.timestamp);
    const provider = r.provider || "unknown";
    const model = r.model || r.alias || "unknown";

    store.hourly[hour] ??= {};
    store.hourly[hour][provider] ??= {};
    store.hourly[hour][provider][model] ??= Object.fromEntries(FIELDS.map((f) => [f, 0]));
    const bucket = store.hourly[hour][provider][model];

    bucket.requests += 1;
    if (r.failed) bucket.failed += 1;
    const t = r.tokens || {};
    bucket.input_tokens += t.input_tokens || 0;
    bucket.output_tokens += t.output_tokens || 0;
    bucket.reasoning_tokens += t.reasoning_tokens || 0;
    bucket.cached_tokens += t.cached_tokens || 0;
    bucket.total_tokens += t.total_tokens || 0;

    store.recent.unshift({
      timestamp: r.timestamp || null,
      provider,
      model,
      failed: !!r.failed,
      latency_ms: r.latency_ms ?? null,
      tokens: t,
      endpoint: r.endpoint || null,
      auth_type: r.auth_type || null,
    });
  }

  if (store.recent.length > MAX_RECENT) store.recent.length = MAX_RECENT;

  const hours = Object.keys(store.hourly).sort();
  if (hours.length > MAX_HOURS) {
    for (const old of hours.slice(0, hours.length - MAX_HOURS)) delete store.hourly[old];
  }

  save(store);
}

/** Sums the given set of hour keys into a { totals, byProviderModel } shape. */
function aggregateHours(store, hourKeys) {
  const byProviderModel = {};
  const totals = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  for (const hour of hourKeys) {
    for (const [provider, models] of Object.entries(store.hourly[hour] || {})) {
      for (const [model, stats] of Object.entries(models)) {
        const key = `${provider}::${model}`;
        byProviderModel[key] ??= { provider, model, ...Object.fromEntries(FIELDS.map((f) => [f, 0])) };
        for (const f of FIELDS) {
          byProviderModel[key][f] += stats[f] || 0;
          totals[f] += stats[f] || 0;
        }
      }
    }
  }

  return { totals, byProviderModel: Object.values(byProviderModel).sort((a, b) => b.total_tokens - a.total_tokens) };
}

/** Aggregates the stored hourly buckets, grouped back into calendar days, over the last `days` calendar days. */
export function getUsageSummary({ days = 7 } = {}) {
  const store = load();
  const allHours = Object.keys(store.hourly).sort();
  const allDays = [...new Set(allHours.map(dayOfHourKey))].sort();
  const wantedDays = new Set(allDays.slice(-Math.max(1, days)));

  const byDay = [];
  for (const day of allDays.filter((d) => wantedDays.has(d))) {
    const hoursInDay = allHours.filter((h) => dayOfHourKey(h) === day);
    const { totals } = aggregateHours(store, hoursInDay);
    byDay.push({ day, total_tokens: totals.total_tokens, requests: totals.requests });
  }

  const wantedHours = allHours.filter((h) => wantedDays.has(dayOfHourKey(h)));
  const { totals, byProviderModel } = aggregateHours(store, wantedHours);

  return {
    totals,
    byProviderModel,
    byDay,
    recent: store.recent.slice(0, 50),
    availableDays: allDays.length,
  };
}

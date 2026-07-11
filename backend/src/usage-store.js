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

function emptyCredFields() {
  return Object.fromEntries(FIELDS.map((f) => [f, 0]));
}

function emptyStore() {
  return { hourly: {}, hourlyByAuth: {}, recent: [] };
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
    return { hourly: parsed.hourly || {}, hourlyByAuth: parsed.hourlyByAuth || {}, recent: parsed.recent || [] };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  ensureDirs();
  fs.writeFileSync(tokensPath(), JSON.stringify(store), "utf8");
}

/**
 * "YYYY-MM-DDTHH" -- truncates a timestamp to the hour. CLIProxyAPI's own
 * record timestamps carry an explicit local offset (e.g.
 * "2026-07-11T20:37:31+07:00"), and getUsageByCredentialWindows() reparses
 * this same "YYYY-MM-DDTHH:00:00" string with no offset -- which JS parses
 * as *local* time -- so every hour key here has to be local-time-shaped too.
 * Falls back to the current wall-clock hour (built from local getters, NOT
 * toISOString(), which is UTC) if the record is missing/has an unparseable
 * timestamp -- a UTC-shaped fallback key would silently misalign by the
 * local UTC offset once reparsed as local time downstream.
 */
function hourKey(isoTimestamp) {
  if (isoTimestamp && !Number.isNaN(Date.parse(isoTimestamp))) return isoTimestamp.slice(0, 13);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
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
    // Stable per-credential id CLIProxyAPI assigns each auth file at runtime
    // -- also present on GET /auth-files entries as `auth_index`, which is
    // what lets routes.js join this per-credential usage back to a specific
    // account (see getUsageByCredential/getUsageByCredentialWindows below).
    const authIndex = r.auth_index !== undefined && r.auth_index !== null ? String(r.auth_index) : null;

    store.hourly[hour] ??= {};
    store.hourly[hour][provider] ??= {};
    store.hourly[hour][provider][model] ??= emptyCredFields();
    const bucket = store.hourly[hour][provider][model];

    bucket.requests += 1;
    if (r.failed) bucket.failed += 1;
    const t = r.tokens || {};
    bucket.input_tokens += t.input_tokens || 0;
    bucket.output_tokens += t.output_tokens || 0;
    bucket.reasoning_tokens += t.reasoning_tokens || 0;
    bucket.cached_tokens += t.cached_tokens || 0;
    bucket.total_tokens += t.total_tokens || 0;

    if (authIndex) {
      store.hourlyByAuth[hour] ??= {};
      store.hourlyByAuth[hour][authIndex] ??= emptyCredFields();
      const credBucket = store.hourlyByAuth[hour][authIndex];
      credBucket.requests += 1;
      if (r.failed) credBucket.failed += 1;
      credBucket.input_tokens += t.input_tokens || 0;
      credBucket.output_tokens += t.output_tokens || 0;
      credBucket.reasoning_tokens += t.reasoning_tokens || 0;
      credBucket.cached_tokens += t.cached_tokens || 0;
      credBucket.total_tokens += t.total_tokens || 0;
    }

    store.recent.unshift({
      timestamp: r.timestamp || null,
      provider,
      model,
      failed: !!r.failed,
      latency_ms: r.latency_ms ?? null,
      tokens: t,
      endpoint: r.endpoint || null,
      auth_type: r.auth_type || null,
      auth_index: authIndex,
    });
  }

  if (store.recent.length > MAX_RECENT) store.recent.length = MAX_RECENT;

  const hours = Object.keys(store.hourly).sort();
  if (hours.length > MAX_HOURS) {
    for (const old of hours.slice(0, hours.length - MAX_HOURS)) {
      delete store.hourly[old];
      delete store.hourlyByAuth[old];
    }
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

/**
 * Per-credential totals (keyed by CLIProxyAPI's `auth_index`, joinable
 * against GET /auth-files entries -- see routes.js's /usage/credentials),
 * summed over the last `days` calendar days of stored hourly buckets.
 */
export function getUsageByCredential({ days = 14 } = {}) {
  const store = load();
  const allHours = Object.keys(store.hourlyByAuth).sort();
  const allDays = [...new Set(allHours.map(dayOfHourKey))].sort();
  const wantedDays = new Set(allDays.slice(-Math.max(1, days)));

  const byAuth = {};
  for (const hour of allHours) {
    if (!wantedDays.has(dayOfHourKey(hour))) continue;
    for (const [authIndex, stats] of Object.entries(store.hourlyByAuth[hour] || {})) {
      byAuth[authIndex] ??= emptyCredFields();
      for (const f of FIELDS) byAuth[authIndex][f] += stats[f] || 0;
    }
  }
  return byAuth;
}

/**
 * Per-credential totals split into two trailing windows -- "last 5 hours"
 * and "last 7 days" -- to pair with the matching rate-limit windows
 * providers like Codex report (see codex-usage.js's primary/secondary
 * windows), so the Usage page can show "X tokens used in this window"
 * alongside the live quota percentage for the same window.
 */
export function getUsageByCredentialWindows() {
  const store = load();
  const now = Date.now();
  const result = {};

  for (const hour of Object.keys(store.hourlyByAuth)) {
    // hour is "YYYY-MM-DDTHH" (see hourKey) in whatever offset the source
    // timestamp used -- parsed as local time here, matching hourKey's own
    // slice-based truncation of the original (locally-offset) timestamp.
    const hourStart = new Date(`${hour}:00:00`).getTime();
    if (Number.isNaN(hourStart)) continue;
    const ageHours = (now - hourStart) / 3_600_000;
    if (ageHours > 168 || ageHours < -1) continue; // older than 7d, or clock skew into the future

    for (const [authIndex, stats] of Object.entries(store.hourlyByAuth[hour] || {})) {
      result[authIndex] ??= { window5h: emptyCredFields(), window7d: emptyCredFields() };
      for (const f of FIELDS) {
        result[authIndex].window7d[f] += stats[f] || 0;
        if (ageHours <= 5) result[authIndex].window5h[f] += stats[f] || 0;
      }
    }
  }
  return result;
}

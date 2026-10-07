/**
 * The signed-in account's spend history, as it crosses the contextBridge.
 *
 * Credential-free like the rest of the bridge: the reads happen in main with the access token
 * it already holds, and only aggregates come back. See src/shared/ipc.ts.
 */

/** Trailing windows the profile screen offers. */
export type UsageWindowId = 'last-24-hours' | 'last-30-days';

/**
 * Width of one chart bar. `hour` is bucketed in main from the raw credit ledger; `day` is the
 * server's own rollup, which is day-granular and cannot be subdivided.
 */
export type UsageGranularity = 'hour' | 'day';

/** One chart bucket. Present even when it spent nothing, so the time axis has no holes. */
export interface UsageBar {
  /** Bucket start, ISO 8601. */
  startsAt: string;
  creditsSpent: number;
  requests: number;
}

/** One row of a breakdown cut, labelled by main because only main knows which cut it came from. */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  /** Secondary label, shown muted beside the first. */
  detail?: string;
  creditsSpent: number;
  requests: number;
}

export interface AccountUsage {
  window: UsageWindowId;
  granularity: UsageGranularity;
  /** Ascending by time. */
  bars: UsageBar[];
  /**
   * Window totals. Summed from `bars` rather than taken from the server's own total, so the
   * headline figure always states exactly what the chart beside it draws.
   */
  creditsSpent: number;
  requests: number;
  byModel: UsageBreakdownRow[];
  byFeature: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
  /** When this answer came off the server, epoch ms. Shown, because the read is cached. */
  readAt: number;
}

/**
 * A window's usage, or why it could not be read.
 *
 * A result rather than a usage object with a nullable field, because the three states the
 * screen has to keep apart - could not read, read nothing, read zero - collapse into one the
 * moment a failed read is allowed to hand back an object full of zeros. An `ok` result whose
 * totals are zero is a real answer: the account spent nothing in that window.
 */
export type AccountUsageResult = { ok: true; usage: AccountUsage } | { ok: false; error: string };

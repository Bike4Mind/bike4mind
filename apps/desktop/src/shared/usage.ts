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

/**
 * Sums over replies from self-hosted models, counted in main from the conversations stored on
 * this device. Speeds stay as token and millisecond sums so a total's rate is tokens over time,
 * never a mean of per-reply rates.
 */
export interface LocalUsageFigures {
  replies: number;
  outputTokens: number;
  /** Summed `inputTokens`: the context each request carried, not the prompt tokens evaluated. */
  contextTokens: number;
  /** Replies the server timed. Estimated and untimed replies count for tokens only. */
  timedReplies: number;
  evalTokens: number;
  evalMs: number;
  /** Replies this app timed off the stream, kept apart from the server-timed ones. */
  estimatedReplies: number;
  estimatedEvalTokens: number;
  estimatedEvalMs: number;
  promptTokens: number;
  promptMs: number;
  /**
   * Server-timed replies that reported a load time, and those times summed. Ollama reports one on
   * every request, warm or not, so this is an average per reply rather than a count of loads.
   */
  loads: number;
  loadMs: number;
  draftTokens: number;
  draftAccepted: number;
}

export interface LocalUsageBar {
  /** Bucket start, ISO 8601. */
  startsAt: string;
  replies: number;
  outputTokens: number;
}

export interface LocalUsageRow {
  key: string;
  label: string;
  detail?: string;
  replies: number;
  outputTokens: number;
  evalTokens: number;
  evalMs: number;
  estimatedEvalTokens: number;
  estimatedEvalMs: number;
}

export interface LocalUsage {
  window: UsageWindowId;
  granularity: UsageGranularity;
  /** Ascending by time; UTC hours or UTC days. */
  bars: LocalUsageBar[];
  /** Summed over the same buckets as `bars`. */
  totals: LocalUsageFigures;
  byModel: LocalUsageRow[];
  byServer: LocalUsageRow[];
  /** Local replies in this scope across all time, so a screen can tell "none ever" from "none lately". */
  allTimeReplies: number;
  /**
   * Which conversations these were counted from: the signed-out device folder, an account's
   * folder, or none while no scope is known. A signed-out screen shows only `device`.
   */
  scope: LocalUsageScope;
  readAt: number;
}

export type LocalUsageScope = 'device' | 'account' | 'none';

export type LocalUsageResult = { ok: true; usage: LocalUsage } | { ok: false; error: string };

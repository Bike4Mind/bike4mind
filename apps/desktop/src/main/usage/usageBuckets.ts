import type { UsageBar, UsageBreakdownRow } from '@shared/usage';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A credit ledger row, narrowed to the two fields the hourly rollup reads. */
export interface LedgerRow {
  createdAt?: unknown;
  credits?: unknown;
}

/** One `IOwnerSpendDay` off the wire, narrowed the same way. */
export interface SpendDay {
  day?: unknown;
  creditsCharged?: unknown;
  requests?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function millis(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

function utcDayStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * One bar per hour over the trailing `hours`, oldest first.
 *
 * `/api/usage` rolls up by UTC day and cannot be subdivided, so the short window is bucketed
 * here out of the raw ledger instead - one day of rows, which is why doing it client-side is
 * affordable at all.
 *
 * Buckets are aligned to the local clock hour rather than to `now`, so the axis reads as hours
 * of the day. Usage rows carry a NEGATIVE `credits` (see CreditTransactionModel's own note);
 * the magnitude is what was spent.
 */
export function hourlyBars(rows: readonly LedgerRow[], now: Date, hours = 24): UsageBar[] {
  const current = new Date(now);
  current.setMinutes(0, 0, 0);
  const start = current.getTime() - (hours - 1) * HOUR_MS;

  const bars: UsageBar[] = Array.from({ length: hours }, (_, index) => ({
    startsAt: new Date(start + index * HOUR_MS).toISOString(),
    creditsSpent: 0,
    requests: 0,
  }));

  for (const row of rows) {
    const at = millis(row.createdAt);
    const credits = finite(row.credits);
    if (at === null || credits === null) continue;
    const index = Math.floor((at - start) / HOUR_MS);
    if (index < 0 || index >= hours) continue;
    bars[index].creditsSpent += Math.abs(credits);
    bars[index].requests += 1;
  }

  return bars;
}

/**
 * One bar per UTC day across the server's own trailing window, oldest first, with the days it
 * reported nothing for filled in as zero.
 *
 * The window starts `days` days back from `now` at the current clock time, so its first bucket
 * is the UTC day that instant falls in - a partial day, and the reason this spans days + 1
 * bars. Trimming it to a round `days` would drop spend the server counted, and the totals
 * drawn above the chart would then be smaller than the window they claim to cover.
 */
export function dailyBars(overTime: readonly SpendDay[], now: Date, days: number): UsageBar[] {
  const reported = new Map<string, SpendDay>();
  for (const row of overTime) {
    if (typeof row.day === 'string') reported.set(row.day, row);
  }

  const first = utcDayStart(now.getTime() - days * DAY_MS);
  const last = utcDayStart(now.getTime());
  const bars: UsageBar[] = [];

  for (let at = first; at <= last; at += DAY_MS) {
    const startsAt = new Date(at).toISOString();
    const row = reported.get(startsAt.slice(0, 10));
    bars.push({
      startsAt,
      creditsSpent: finite(row?.creditsCharged) ?? 0,
      requests: finite(row?.requests) ?? 0,
    });
  }

  return bars;
}

/** `agent_execution` -> `Agent execution`. The slugs are the wire's, not anything a user wrote. */
export function humanize(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

export function modelRows(byModel: readonly Record<string, unknown>[]): UsageBreakdownRow[] {
  return byModel.map(row => {
    const model = typeof row.model === 'string' ? row.model : 'Unknown model';
    const provider = typeof row.provider === 'string' ? row.provider : '';
    return {
      key: `${provider}:${model}`,
      label: model,
      ...(provider ? { detail: provider } : {}),
      creditsSpent: finite(row.creditsCharged) ?? 0,
      requests: finite(row.requests) ?? 0,
    };
  });
}

export function featureRows(byFeature: readonly Record<string, unknown>[]): UsageBreakdownRow[] {
  return byFeature.map(row => {
    const feature = typeof row.feature === 'string' ? row.feature : 'unknown';
    return {
      key: feature,
      label: humanize(feature),
      creditsSpent: finite(row.creditsCharged) ?? 0,
      requests: finite(row.requests) ?? 0,
    };
  });
}

/** The by-source cut comes off the ledger, which names its spend `creditsSpent`, not `creditsCharged`. */
export function sourceRows(bySource: readonly Record<string, unknown>[]): UsageBreakdownRow[] {
  return bySource.map(row => {
    const source = typeof row.source === 'string' ? row.source : 'unknown';
    return {
      key: source,
      label: humanize(source),
      creditsSpent: finite(row.creditsSpent) ?? 0,
      requests: finite(row.requests) ?? 0,
    };
  });
}

export function sumBars(bars: readonly UsageBar[]): { creditsSpent: number; requests: number } {
  return bars.reduce(
    (total, bar) => ({
      creditsSpent: total.creditsSpent + bar.creditsSpent,
      requests: total.requests + bar.requests,
    }),
    { creditsSpent: 0, requests: 0 }
  );
}

import type { AdminCreditSummary } from '@bike4mind/common';
import { AI_SPEND_DAILY_WINDOW_DAYS } from '@bike4mind/database';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One entry per UTC day, oldest first, ending on the day of `now`; days without spend are zero. */
export function zeroFilledDailySpend(
  sparse: Array<{ day: string; credits: number }>,
  now: Date
): AdminCreditSummary['daily'] {
  const byDay = new Map(sparse.map(({ day, credits }) => [day, credits]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: AI_SPEND_DAILY_WINDOW_DAYS }, (_, index) => {
    const date = new Date(today - (AI_SPEND_DAILY_WINDOW_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { date, credits: byDay.get(date) ?? 0 };
  });
}

type SpendBucket = { key: string | null; last7d: number; last30d: number; last90d: number };
type SpendTotals = { last24h: number; last7d: number; last30d: number };

export type ChargedSpend = {
  spent: SpendTotals;
  writtenOff: SpendTotals;
  topModel30d: { model: string; credits: number } | null;
  dailyCredits: Array<{ day: string; credits: number }>;
  byModel: SpendBucket[];
  bySource: SpendBucket[];
};

/**
 * Takes written-off shortfalls out of a ledger spend summary, so every figure counts credits charged
 * and the write-offs are reported on their own. Windows mirror summarizeAiSpend: rolling for `spent`,
 * whole UTC days for the daily series and the breakdowns.
 */
export function chargedSpend(
  spend: {
    spent: SpendTotals;
    topModel30d: { model: string; credits: number } | null;
    dailyCredits: Array<{ day: string; credits: number }>;
    byModel: SpendBucket[];
    bySource: SpendBucket[];
  },
  writeOffs: ReadonlyArray<{ createdAt: Date; writtenOffCredits: number; model?: string; source?: string }>,
  now: Date
): ChargedSpend {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rollingFrom = (days: number) => now.getTime() - days * DAY_MS;
  const dayAlignedFrom = (days: number) => dayStart - (days - 1) * DAY_MS;
  const sumSince = (from: number, match: (writeOff: (typeof writeOffs)[number]) => boolean = () => true) =>
    writeOffs.reduce(
      (sum, writeOff) =>
        writeOff.createdAt.getTime() >= from && match(writeOff) ? sum + writeOff.writtenOffCredits : sum,
      0
    );

  const writtenOff = {
    last24h: sumSince(rollingFrom(1)),
    last7d: sumSince(rollingFrom(7)),
    last30d: sumSince(rollingFrom(30)),
  };
  const net = (gross: number, off: number) => Math.max(0, gross - off);

  const dailyOff = new Map<string, number>();
  for (const writeOff of writeOffs) {
    const day = writeOff.createdAt.toISOString().slice(0, 10);
    dailyOff.set(day, (dailyOff.get(day) ?? 0) + writeOff.writtenOffCredits);
  }
  const bucketsLess = (buckets: SpendBucket[], keyOf: (writeOff: (typeof writeOffs)[number]) => string | null) =>
    buckets
      .map(bucket => {
        const match = (writeOff: (typeof writeOffs)[number]) => keyOf(writeOff) === bucket.key;
        return {
          key: bucket.key,
          last7d: net(bucket.last7d, sumSince(dayAlignedFrom(7), match)),
          last30d: net(bucket.last30d, sumSince(dayAlignedFrom(30), match)),
          last90d: net(bucket.last90d, sumSince(dayAlignedFrom(AI_SPEND_DAILY_WINDOW_DAYS), match)),
        };
      })
      .sort((a, b) => b.last90d - a.last90d);

  const byModel = bucketsLess(spend.byModel, writeOff => writeOff.model ?? null);
  const top = byModel
    .filter(bucket => bucket.key !== null && bucket.last30d > 0)
    .sort((a, b) => b.last30d - a.last30d)[0];
  return {
    spent: {
      last24h: net(spend.spent.last24h, writtenOff.last24h),
      last7d: net(spend.spent.last7d, writtenOff.last7d),
      last30d: net(spend.spent.last30d, writtenOff.last30d),
    },
    writtenOff,
    topModel30d: top && top.key !== null ? { model: top.key, credits: top.last30d } : null,
    dailyCredits: spend.dailyCredits.map(({ day, credits }) => ({
      day,
      credits: net(credits, dailyOff.get(day) ?? 0),
    })),
    byModel,
    bySource: bucketsLess(spend.bySource, writeOff => writeOff.source ?? null),
  };
}

import { AnalyticsDaily, UsageEvent } from '@bike4mind/database';
import { formatDay, rollupDay } from '@server/analytics/analyticsRollup';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOOKUP_DEADLINE_MS = 120_000;

export interface BackfillAnalyticsRollupOptions {
  dryRun: boolean;
  /** Inclusive UTC day (YYYY-MM-DD). Defaults to the day of the earliest usage event. */
  from?: string;
  /** Inclusive UTC day (YYYY-MM-DD). Defaults to yesterday UTC. */
  to?: string;
  /** Recompute days that already have a daily row. */
  force?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

export interface BackfillAnalyticsRollupResult {
  from: string | null;
  to: string | null;
  /** Days rolled up (or, in a dry run, that would be). */
  processed: number;
  /** Days skipped because a daily row already exists. */
  skipped: number;
}

const assertDay = (value: string, label: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!DAY_RE.test(value) || Number.isNaN(date.getTime()) || formatDay(date) !== value) {
    throw new Error(`${label} must be a UTC day formatted YYYY-MM-DD, got "${value}"`);
  }
};

/**
 * Rebuilds the analytics rollup tables one UTC day at a time via the same rollupDay the nightly cron
 * uses. Resumable and idempotent: rollupDay writes the daily row last, so a day that already has one
 * is complete and is skipped unless `force` is set, and a re-run of any day rewrites identical rows.
 */
export async function backfillAnalyticsRollup(
  options: BackfillAnalyticsRollupOptions
): Promise<BackfillAnalyticsRollupResult> {
  const { dryRun, force = false, now = new Date(), log = console.log } = options;

  const to = options.to ?? formatDay(new Date(now.getTime() - DAY_MS));
  assertDay(to, '--to');

  let from = options.from;
  if (from) {
    assertDay(from, '--from');
  } else {
    const earliest = await UsageEvent.findOne({}, { createdAt: 1 })
      .sort({ createdAt: 1 })
      .maxTimeMS(LOOKUP_DEADLINE_MS)
      .lean();
    if (!earliest?.createdAt) {
      log('No usage events found; nothing to backfill.');
      return { from: null, to, processed: 0, skipped: 0 };
    }
    from = formatDay(new Date(earliest.createdAt));
  }
  if (from > to) throw new Error(`--from (${from}) is after --to (${to})`);

  const done = new Set<string>();
  if (!force) {
    const rows = await AnalyticsDaily.find({ day: { $gte: from, $lte: to } }, { day: 1 })
      .maxTimeMS(LOOKUP_DEADLINE_MS)
      .lean();
    for (const row of rows) done.add(row.day);
  }

  let processed = 0;
  let skipped = 0;
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); formatDay(new Date(ms)) <= to; ms += DAY_MS) {
    const day = formatDay(new Date(ms));
    if (done.has(day)) {
      skipped++;
      continue;
    }
    if (dryRun) {
      log(`[dry run] would roll up ${day}`);
    } else {
      const result = await rollupDay(day, { now });
      log(`${day}: dau=${result.dau} wau=${result.wau} mau=${result.mau}`);
    }
    processed++;
  }
  log(
    `${dryRun ? 'Would process' : 'Processed'} ${processed} day(s), skipped ${skipped} already rolled up (${from}..${to}).`
  );
  return { from, to, processed, skipped };
}

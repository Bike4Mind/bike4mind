import { SPEND_BUCKET_MS, type ISpendRollupRepository } from '@bike4mind/common';
import { composeAlarmMessage, escapeMrkdwn, type SlackAlarmMessage } from '../../events/alarmSlackMessage';

/** The check runs once a day, on the one 5-minute cron tick that lands in this UTC hour's first 5 minutes. */
export const MARGIN_CHECK_UTC_HOUR = 0;
const CRON_INTERVAL_MINUTES = 5;
const HOUR_MS = 60 * 60 * 1000;
const MAX_LISTED_MODELS = 15;

export type MarginThresholds = {
  /** Revenue/cost ratio below which a model is flagged; 1 means "charged less than it cost". */
  minRatio: number;
  windowHours: number;
  /** A model needs at least this much provider cost in the window before it can be flagged. */
  costFloorUsd: number;
};

export type MarginFinding = {
  model: string;
  costUsd: number;
  creditsCharged: number;
  revenueUsd: number;
  /** revenueUsd / costUsd. */
  ratio: number;
  requests: number;
};

export type MarginCheckDeps = {
  rollups: Pick<ISpendRollupRepository, 'sumWindow' | 'latestBucketStart'>;
  post: (message: SlackAlarmMessage) => Promise<void>;
  messageContext: { creditUsd: number; stage: string };
  logger: { log: (...args: unknown[]) => void };
};

export function isMarginCheckSlot(now: Date): boolean {
  return now.getUTCHours() === MARGIN_CHECK_UTC_HOUR && now.getUTCMinutes() < CRON_INTERVAL_MINUTES;
}

/**
 * Compares UsageEvent-sourced creditsCharged with costUsd, not the ledger `credits` column: both come
 * from the same rows, so a model's cost and its charge cannot drift apart through a missing dual write
 * or a generic_deduct that has no usage event.
 */
export function findMarginShortfalls(
  totals: Iterable<{ scopeId: string; costUsd: number; creditsCharged: number; requests: number }>,
  thresholds: Pick<MarginThresholds, 'minRatio' | 'costFloorUsd'>,
  creditUsd: number
): MarginFinding[] {
  const findings: MarginFinding[] = [];
  for (const { scopeId, costUsd, creditsCharged, requests } of totals) {
    if (costUsd <= 0 || costUsd < thresholds.costFloorUsd) continue;
    const revenueUsd = creditsCharged * creditUsd;
    const ratio = revenueUsd / costUsd;
    if (ratio >= thresholds.minRatio) continue;
    findings.push({ model: scopeId, costUsd, creditsCharged, revenueUsd, ratio, requests });
  }
  return findings.sort((a, b) => b.costUsd - b.revenueUsd - (a.costUsd - a.revenueUsd));
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function buildMarginMessage(
  findings: MarginFinding[],
  thresholds: MarginThresholds,
  context: MarginCheckDeps['messageContext']
): SlackAlarmMessage {
  const listed = findings.slice(0, MAX_LISTED_MODELS);
  const lines = listed.map(
    finding =>
      `- \`${escapeMrkdwn(finding.model)}\`: cost ${usd(finding.costUsd)}, charged ${usd(finding.revenueUsd)} ` +
      `(${Math.round(finding.creditsCharged).toLocaleString('en-US')} credits), ratio ${finding.ratio.toFixed(2)}, ` +
      `${finding.requests.toLocaleString('en-US')} requests`
  );
  const hidden = findings.length - listed.length;
  if (hidden > 0) lines.push(`+${hidden} more`);
  const shortfall = findings.reduce((sum, finding) => sum + finding.costUsd - finding.revenueUsd, 0);
  const plural = findings.length === 1 ? '' : 's';

  return composeAlarmMessage({
    stage: context.stage,
    level: 'warn',
    title: `Model margin: ${findings.length} model${plural} charged below provider cost`,
    fields: [
      `*Window*\nLast ${thresholds.windowHours}h`,
      `*Shortfall*\n${usd(shortfall)}`,
      `*Flag below ratio*\n${thresholds.minRatio}`,
      `*Cost floor*\n${usd(thresholds.costFloorUsd)} per model`,
    ],
    sections: [`*Models*\n${lines.join('\n')}`],
    context: [
      escapeMrkdwn(
        `Charged USD = credits charged x ${context.creditUsd} (the lowest per-credit price), so a model listed here may still break even at list price.`
      ),
      escapeMrkdwn(
        'Includes local-tokenizer settlements, free-tier usage, write-offs and absorbed timeouts; confirm against UsageEvent providerInputTokens/providerOutputTokens and settledBasis before repricing.'
      ),
    ],
    summary: `${findings.length} model${plural} below ${thresholds.minRatio}x margin, ${usd(shortfall)} short in the last ${thresholds.windowHours}h`,
  });
}

/** Sums the trailing window up to the newest rolled bucket and posts one digest when any model is short. */
export async function runMarginCheck(
  deps: MarginCheckDeps,
  thresholds: MarginThresholds
): Promise<{ checked: number; flagged: number }> {
  const latest = await deps.rollups.latestBucketStart();
  if (!latest) return { checked: 0, flagged: 0 };
  const to = new Date(latest.getTime() + SPEND_BUCKET_MS);
  const from = new Date(to.getTime() - thresholds.windowHours * HOUR_MS);

  const totals = await deps.rollups.sumWindow('model', from, to);
  const findings = findMarginShortfalls(totals.values(), thresholds, deps.messageContext.creditUsd);
  deps.logger.log('spend-monitor-margin-checked', {
    from: from.toISOString(),
    to: to.toISOString(),
    models: totals.size,
    flagged: findings.map(({ model, ratio, costUsd }) => ({ model, ratio, costUsd })),
  });
  if (findings.length > 0) await deps.post(buildMarginMessage(findings, thresholds, deps.messageContext));
  return { checked: totals.size, flagged: findings.length };
}

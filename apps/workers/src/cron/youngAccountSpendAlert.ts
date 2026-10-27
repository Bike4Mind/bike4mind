import { Logger } from '@bike4mind/observability';
import { getSettingsMap } from '@bike4mind/utils';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import type { YoungAccountSpendSummary } from '@bike4mind/database';
import { resolveSlackWebhookUrl } from '@bike4mind/server-utils/integrations/slack/slack';
import { Config } from '@bike4mind/server-utils/utils/config';
import axios from 'axios';
import { Resource } from 'sst';
import { z } from 'zod';

const HOUR_MS = 60 * 60 * 1000;
const TOP_SPENDER_LIMIT = 10;

export type YoungAccountSpendThresholds = {
  credits: number;
  accounts: number;
};

function parseThreshold(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1, got "${raw}"`);
  }
  return value;
}

/** Deploy-time ceilings; see infra/signup-code-send-alarm.md. */
export function readYoungAccountSpendThresholds(): YoungAccountSpendThresholds {
  return {
    credits: parseThreshold('YOUNG_ACCOUNT_SPEND_ALERT_CREDITS', 5000),
    accounts: parseThreshold('YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS', 25),
  };
}

/** Alerts only when a ceiling is exceeded, not merely reached. */
export function shouldAlertYoungAccountSpend(
  summary: YoungAccountSpendSummary,
  thresholds: YoungAccountSpendThresholds
): boolean {
  return summary.totalCredits > thresholds.credits || summary.accountCount > thresholds.accounts;
}

export function formatYoungAccountSpendMessage(
  summary: YoungAccountSpendSummary,
  thresholds: YoungAccountSpendThresholds,
  window: { start: Date; end: Date },
  stage: string
): string {
  const lines = [
    `:rotating_light: *Young-account spend alert (${stage})*`,
    `Window: ${window.start.toISOString()} to ${window.end.toISOString()}`,
    `Accounts created in the last 7 days spent ${summary.totalCredits.toLocaleString('en-US')} credits ` +
      `across ${summary.accountCount} accounts ` +
      `(ceilings: ${thresholds.credits.toLocaleString('en-US')} credits, ${thresholds.accounts} accounts).`,
    `Top ${summary.topSpenders.length} by spend:`,
    ...summary.topSpenders.map(
      (spender, index) =>
        `${index + 1}. \`${spender.userId}\` ${spender.creditsSpent.toLocaleString('en-US')} credits ` +
        `(created ${new Date(spender.accountCreatedAt).toISOString()})`
    ),
  ];
  return lines.join('\n');
}

const scheduledEventSchema = z.object({ time: z.iso.datetime() });

export async function handler(event: unknown) {
  const logger = new Logger().withMetadata({ cron: 'youngAccountSpendAlert', stage: Resource.App.stage });

  if (Resource.App.stage !== 'production') {
    return { status: 'skipped', reason: 'non-production environment' };
  }

  const thresholds = readYoungAccountSpendThresholds();
  // Event time stays fixed across delayed delivery and retries, so hourly windows stay adjacent.
  const end = new Date(scheduledEventSchema.parse(event).time);
  const start = new Date(end.getTime() - HOUR_MS);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const summary = await counterLogRepository.findYoungAccountSpend(start, end, TOP_SPENDER_LIMIT);
  logger.log('young-account-spend', {
    totalCredits: summary.totalCredits,
    accountCount: summary.accountCount,
    thresholds,
  });

  if (!shouldAlertYoungAccountSpend(summary, thresholds)) {
    return { status: 'ok', totalCredits: summary.totalCredits, accountCount: summary.accountCount };
  }

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const webhookUrl = resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', settings);
  if (!webhookUrl) {
    throw new Error('young-account spend alert breached but no Slack webhook is configured');
  }

  await axios.post(webhookUrl, {
    text: formatYoungAccountSpendMessage(summary, thresholds, { start, end }, Resource.App.stage),
  });
  return { status: 'alerted', totalCredits: summary.totalCredits, accountCount: summary.accountCount };
}

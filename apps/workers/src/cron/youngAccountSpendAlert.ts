import { Logger } from '@bike4mind/observability';
import { getSettingsMap } from '@bike4mind/utils';
import { escapeSlackText, toAbsoluteUrl } from '@bike4mind/common';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import type { YoungAccountSpendSummary, YoungAccountSpender } from '@bike4mind/database';
import { resolveSlackWebhookUrl } from '@server/integrations/slack/slack';
import { stripeCustomerSlackLink } from '@server/integrations/slack/accountLinks';
import { appUrlFromEnv } from '../events/alarmSlackMessage';
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

function slackLink(url: string, label: string): string {
  return `<${escapeSlackText(url)}|${label}>`;
}

/** Same path as adminOwnerPath in apps/client/server/integrations/slack/subscriptionLifecycle.ts. */
function adminUserLink(userId: string, appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  return slackLink(toAbsoluteUrl(appUrl, `/admin/users/${encodeURIComponent(userId)}`), 'admin');
}

function formatSpenderLine(
  spender: YoungAccountSpender,
  rank: number,
  stage: string,
  appUrl: string | undefined
): string {
  const links = [adminUserLink(spender.userId, appUrl), stripeCustomerSlackLink(spender.stripeCustomerId, stage)];
  return (
    `${rank}. \`${escapeSlackText(spender.userId)}\` ${spender.creditsSpent.toLocaleString('en-US')} credits ` +
    `(created ${new Date(spender.accountCreatedAt).toISOString()}) - ` +
    links.filter((link): link is string => link !== null).join(' | ')
  );
}

export function formatYoungAccountSpendMessage(
  summary: YoungAccountSpendSummary,
  thresholds: YoungAccountSpendThresholds,
  window: { start: Date; end: Date },
  stage: string,
  appUrl: string | undefined
): string {
  const lines = [
    `:rotating_light: *Young-account spend alert (${stage})*`,
    `Window: ${window.start.toISOString()} to ${window.end.toISOString()}`,
    `Accounts created in the last 7 days spent ${summary.totalCredits.toLocaleString('en-US')} credits ` +
      `across ${summary.accountCount} accounts ` +
      `(ceilings: ${thresholds.credits.toLocaleString('en-US')} credits, ${thresholds.accounts} accounts).`,
    `Top ${summary.topSpenders.length} by spend:`,
    ...summary.topSpenders.map((spender, index) => formatSpenderLine(spender, index + 1, stage, appUrl)),
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
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
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

  const appUrl = appUrlFromEnv();
  if (!appUrl) {
    // Still post: a spend alert without admin links beats no alert at all.
    logger.error('young-account spend alert has no SERVER_DOMAIN; admin links omitted');
  }
  await axios.post(webhookUrl, {
    text: formatYoungAccountSpendMessage(summary, thresholds, { start, end }, Resource.App.stage, appUrl),
  });
  return { status: 'alerted', totalCredits: summary.totalCredits, accountCount: summary.accountCount };
}

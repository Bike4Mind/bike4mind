import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { escapeSlackLine, escapeSlackText, toAbsoluteUrl } from '@bike4mind/common';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import type { YoungAccountSpendSummary, YoungAccountSpender } from '@bike4mind/database';
import { stripeCustomerSlackLink } from '@server/integrations/slack/accountLinks';
import {
  ADMIN_LINKS,
  appUrlFromEnv,
  composeAlarmMessage,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
  type SlackAlarmMessage,
} from '../events/alarmSlackMessage';
import { readAlarmMention } from '../events/alarmSlackMention';
import { recordYoungAccountSpendShadowDetections } from './youngAccountSpendShadowDetections';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { z } from 'zod';

const HOUR_MS = 60 * 60 * 1000;
const TOP_SPENDER_LIMIT = 10;
/** Slack rejects a section over 3000 characters, which would drop the whole post. */
const SECTION_TEXT_MAX = 2_900;
const EMAIL_MAX = 64;

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
  const who = spender.email
    ? escapeSlackLine(spender.email.slice(0, EMAIL_MAX))
    : `\`${escapeSlackText(spender.userId)}\``;
  return (
    `${rank}. ${who} ${spender.creditsSpent.toLocaleString('en-US')} credits ` +
    `(created ${new Date(spender.accountCreatedAt).toISOString()}) - ` +
    links.filter((link): link is string => link !== null).join(' | ')
  );
}

const formatCount = (value: number) => value.toLocaleString('en-US');

/** The same card shape as the CloudWatch alarm relay, so it sits in the alarms channel beside them. */
export function buildYoungAccountSpendMessage(
  summary: YoungAccountSpendSummary,
  thresholds: YoungAccountSpendThresholds,
  window: { start: Date; end: Date },
  stage: string,
  appUrl: string | undefined,
  mention?: string
): SlackAlarmMessage {
  const fields = [
    `*Window*\n${window.start.toISOString()} to ${window.end.toISOString()}`,
    `*Credits (ceiling)*\n${formatCount(summary.totalCredits)} (${formatCount(thresholds.credits)})`,
    `*Accounts (ceiling)*\n${formatCount(summary.accountCount)} (${formatCount(thresholds.accounts)})`,
  ];
  const sections = [
    'Accounts under 7 days old spent more credits in the last hour than the ceiling, or more of them ' +
      'spent than the account ceiling. Credit farms spend their free credits fast.',
  ];
  if (summary.topSpenders.length > 0) {
    const lines = summary.topSpenders.map((spender, index) => formatSpenderLine(spender, index + 1, stage, appUrl));
    const title = `*Top ${summary.topSpenders.length} by credits*`;
    let text = `${title}\n${lines.join('\n')}`;
    while (text.length > SECTION_TEXT_MAX && lines.length > 1) {
      lines.pop();
      text = `${title}\n${lines.join('\n')}\nand ${summary.topSpenders.length - lines.length} more`;
    }
    sections.push(text);
  }
  const origin = appUrl?.replace(/\/+$/, '');
  const buttons = origin
    ? [{ label: ADMIN_LINKS['spend-monitor'].label, url: `${origin}${ADMIN_LINKS['spend-monitor'].path}` }]
    : [];

  return composeAlarmMessage({
    stage,
    level: 'warn',
    title: 'Young accounts are spending a lot of credits',
    mention,
    fields,
    sections,
    buttons,
    context: [escapeSlackText(stage), 'warning', 'credit ledger, accounts under 7 days old'],
    summary: `${formatCount(summary.totalCredits)} credits across ${formatCount(summary.accountCount)} young accounts in the last hour`,
  });
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
  // Before the Slack step and never throws, so a delivery failure neither loses nor fails the record.
  if (getSettingsValue('shadowDetectionRecordingEnabled', settings, true)) {
    const recorded = await recordYoungAccountSpendShadowDetections({
      summary,
      thresholds,
      window: { start, end },
      logger,
    });
    // 0 with listed spenders means every claim was taken, i.e. this window was already recorded.
    logger.log('young-account-spend-shadow-detections', { recorded, listed: summary.topSpenders.length });
  }
  const webhookUrl = resolveAlarmWebhookUrl(Resource, 'abuse');
  const appUrl = appUrlFromEnv();
  if (!appUrl) {
    // Still post: a spend alert without admin links beats no alert at all.
    logger.error('young-account spend alert has no SERVER_DOMAIN; admin links omitted');
  }
  const message = buildYoungAccountSpendMessage(
    summary,
    thresholds,
    { start, end },
    Resource.App.stage,
    appUrl,
    await readAlarmMention()
  );
  await postAlarmToSlack(webhookUrl, message);
  return { status: 'alerted', totalCredits: summary.totalCredits, accountCount: summary.accountCount };
}

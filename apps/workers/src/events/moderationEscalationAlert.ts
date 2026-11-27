import type { EventBridgeEvent } from 'aws-lambda';
import {
  adminTextModerationReviewPath,
  escapeSlackText,
  MODERATION_SOURCE_LABELS,
  toAbsoluteUrl,
} from '@bike4mind/common';
import { spendRollupRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { ModerationEvents } from '@bike4mind/server-utils/utils/eventBus';
import { Resource } from 'sst';
import type { z } from 'zod';
import { withEventContext } from '@workers/utils/eventContext';
import {
  appUrlFromEnv,
  composeAlarmMessage,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
  type AlarmLevel,
  type SlackAlarmMessage,
} from './alarmSlackMessage';
import { readAlarmMention } from './alarmSlackMention';
import { defaultPaidScopeDeps } from '../cron/spendMonitor/paidScopes';
import { defaultResolveScopeDeps, scopeMapKey } from '../cron/spendMonitor/resolveScope';
import { FUNDING_LABELS, formatAccountAge } from '../cron/spendMonitor/slackMessage';
import {
  defaultTopAccountContextDeps,
  resolveTopAccountContexts,
  type ResolveTopAccountContextDeps,
  type TopAccountContext,
} from '../cron/spendMonitor/topAccountContext';

export type ModerationEscalation = z.infer<typeof ModerationEvents.Escalation.schema>;

/** The account lookup never holds the alert back longer than this (ms). */
const ACCOUNT_CONTEXT_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ModerationEscalationMessageInput = {
  alert: ModerationEscalation;
  /** Null when the lookup failed or timed out; the alert still goes out. */
  account: Pick<TopAccountContext, 'ageMs' | 'funding'> | null;
  stage: string;
  appUrl: string | undefined;
  mention?: string;
};

const severe = (alert: ModerationEscalation) => alert.reasons.includes('severe_category');
const pendingSuspension = (alert: ModerationEscalation) => alert.reasons.includes('suspend_pending');

function titleOf(alert: ModerationEscalation): string {
  if (severe(alert) && pendingSuspension(alert)) return 'Severe moderation hit; user pending suspension';
  if (severe(alert)) return 'Severe moderation hit';
  return 'User pending suspension for repeated moderation hits';
}

/**
 * The Slack post for one escalation: the event, its categories, the 24h hit count, the account's age and
 * funding, and admin links. No email, prompt text or quest id.
 */
export function buildModerationEscalationMessage(input: ModerationEscalationMessageInput): SlackAlarmMessage {
  const { alert, account, stage, appUrl } = input;
  const level: AlarmLevel = severe(alert) ? 'page' : 'warn';
  const categories = alert.categories.length > 0 ? alert.categories.join(', ') : 'none reported';
  const accountLine = account
    ? `${formatAccountAge(account.ageMs)}, ${FUNDING_LABELS[account.funding]}`
    : 'unavailable';
  const action = severe(alert)
    ? 'Review this user now: confirm the suspension or clear them from the review list.'
    : 'Review the hits and appeal, then confirm the suspension, keep them throttled, or return them to active.';
  const buttons = appUrl
    ? [
        { label: 'Open user', url: toAbsoluteUrl(appUrl, `/admin/users/${encodeURIComponent(alert.userId)}`) },
        { label: 'Review list', url: toAbsoluteUrl(appUrl, adminTextModerationReviewPath()) },
      ]
    : [];
  return composeAlarmMessage({
    stage,
    level,
    title: titleOf(alert),
    mention: input.mention,
    fields: [
      `*Categories*\n${escapeSlackText(categories)}`,
      `*Hits in 24h*\n${alert.hitsInWindow}`,
      `*Account*\n${escapeSlackText(accountLine)}`,
      `*Flagged by*\n${MODERATION_SOURCE_LABELS[alert.source]}`,
    ],
    sections: [escapeSlackText(action)],
    buttons,
    context: [escapeSlackText(stage), level === 'page' ? 'page' : 'warning', 'text-prompt moderation'],
    summary: `${categories}; ${alert.hitsInWindow} hit(s) in 24h`,
  });
}

export type ModerationEscalationDeps = {
  resolveAccount: (userId: string, now: Date) => Promise<Pick<TopAccountContext, 'ageMs' | 'funding'> | null>;
  post: (message: SlackAlarmMessage) => Promise<void>;
  readMention: () => Promise<string | undefined>;
  stage: string;
  appUrl: string | undefined;
  now?: () => Date;
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Posts one `moderation.escalation` event to the abuse alarm channel. A malformed event is consumed,
 * not thrown: redelivering it can never succeed. A failed account lookup degrades the post; a failed
 * post throws so the event bus retries and, after that, dead-letters it.
 */
export async function handleModerationEscalation(
  detail: unknown,
  deps: ModerationEscalationDeps,
  logger: Pick<Logger, 'warn' | 'info' | 'updateMetadata'>
): Promise<void> {
  const parsed = ModerationEvents.Escalation.schema.safeParse(detail);
  if (!parsed.success) {
    logger.warn('moderation.escalation event malformed; dropping', { reason: parsed.error.message });
    return;
  }
  const alert = parsed.data;
  logger.updateMetadata({ handler: 'moderationEscalationAlert', userId: alert.userId, reasons: alert.reasons });

  const now = deps.now?.() ?? new Date();
  let account: Pick<TopAccountContext, 'ageMs' | 'funding'> | null = null;
  try {
    account = await withTimeout(deps.resolveAccount(alert.userId, now), ACCOUNT_CONTEXT_TIMEOUT_MS);
  } catch (error) {
    logger.warn('moderation-escalation-account-context-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const mention = await deps.readMention();
  await deps.post(
    buildModerationEscalationMessage({ alert, account, stage: deps.stage, appUrl: deps.appUrl, mention })
  );
  logger.info('moderation-escalation-alert-posted', { reasons: alert.reasons });
}

/** Account age and funding, read the way the platform spend alarms read them. */
async function resolveAccount(userId: string, now: Date): Promise<Pick<TopAccountContext, 'ageMs' | 'funding'> | null> {
  const deps: ResolveTopAccountContextDeps = {
    topAccountContextDeps: defaultTopAccountContextDeps(),
    rollups: spendRollupRepository,
    resolveScopeDeps: defaultResolveScopeDeps(),
    paidScopeDeps: defaultPaidScopeDeps(),
  };
  const contexts = await resolveTopAccountContexts(
    [{ scopeType: 'User', scopeId: userId }],
    { start: new Date(now.getTime() - DAY_MS), end: now },
    deps
  );
  return contexts.get(scopeMapKey('User', userId)) ?? null;
}

const handleWithContext = withEventContext(async (event, logger) => {
  const webhookUrl = resolveAlarmWebhookUrl(Resource, 'abuse');
  await handleModerationEscalation(
    event.properties,
    {
      resolveAccount,
      post: message => postAlarmToSlack(webhookUrl, message),
      readMention: () => readAlarmMention(),
      stage: Resource.App.stage,
      appUrl: appUrlFromEnv(),
    },
    logger
  );
});

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  await handleWithContext(event);
};

import { paymentRiskActionRepository, userRepository } from '@bike4mind/database';
import { escapeSlackText } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { adminUserSlackRef, stripeCustomerSlackLink } from '@server/integrations/slack/accountLinks';
import { Resource } from 'sst';

const HOUR_MS = 60 * 60 * 1000;

export type FraudBlockKind = 'newAccountSpendCap' | 'checkoutRefused' | 'ipBlocked' | 'signupUnlockForfeited';

const TITLES: Record<FraudBlockKind, string> = {
  newAccountSpendCap: 'new-account spend cap refused a request',
  checkoutRefused: 'checkout refused',
  ipBlocked: 'request from a blocked network refused',
  signupUnlockForfeited: 'held signup unlock forfeited',
};

export type FraudBlockAlert = {
  kind: FraudBlockKind;
  userId: string | null;
  /** The dedupe subject when no user is known, e.g. a signed-out request from a blocked network. */
  ip?: string | null;
  /** Slack mrkdwn lines; the caller escapes anything it did not write itself. */
  details: string[];
};

/** One key per subject, kind and clock hour: the claim on it is what limits a retrying attacker to one post. */
export function fraudBlockAlertKey(kind: FraudBlockKind, subject: string, now: Date): string {
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  return `fraud-block-alert:${kind}:${subject}:${hour}`;
}

// The durable dedupe is the claim on PaymentRiskAction; this only spares the database a write per
// retried request within one container. Keys carry their hour, so a stale entry never matches again.
const MAX_SETTLED_KEYS = 1_000;
const settledKeys = new Set<string>();

/** Test seam: forget which keys this container has already settled. */
export function resetFraudBlockAlertMemo(): void {
  settledKeys.clear();
}

function rememberSettled(key: string): void {
  if (settledKeys.size >= MAX_SETTLED_KEYS) settledKeys.clear();
  settledKeys.add(key);
}

export function formatFraudBlockAlert(alert: FraudBlockAlert, stripeCustomerId: string | null, stage: string): string {
  const who = alert.userId
    ? `*User:* ${adminUserSlackRef(alert.userId)} | ${stripeCustomerSlackLink(stripeCustomerId, stage)}`
    : `*User:* signed out${alert.ip ? ` (IP \`${escapeSlackText(alert.ip)}\`)` : ''}`;
  return [
    `:no_entry: *Fraud block (${escapeSlackText(stage)}): ${TITLES[alert.kind]}*`,
    who,
    ...alert.details,
    `_Further blocks of this kind for this ${alert.userId ? 'user' : 'IP'} are not posted until the next hour._`,
  ].join('\n');
}

/**
 * Posts an automatic fraud block to LiveOps, at most once per user (or IP, when signed out) per block
 * kind per clock hour, so retries cannot flood the channel. Never throws: the block has already been
 * decided, and a failed alert must not turn it into a 500 or a webhook retry.
 */
export async function alertFraudBlock(alert: FraudBlockAlert, now: Date = new Date()): Promise<void> {
  const subject = alert.userId ?? alert.ip;
  if (!subject) return;
  const key = fraudBlockAlertKey(alert.kind, subject, now);
  if (settledKeys.has(key)) return;
  try {
    const won = await paymentRiskActionRepository.claimStep(key, 'slack', alert.userId);
    rememberSettled(key);
    if (!won) return;
    const user = alert.userId ? await userRepository.findById(alert.userId) : null;
    await postMessageToSlack(formatFraudBlockAlert(alert, user?.stripeCustomerId ?? null, Resource.App.stage));
  } catch (error) {
    Logger.error('[FraudBlockAlert] could not alert LiveOps', {
      kind: alert.kind,
      userId: alert.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

import {
  adminSettingsRepository,
  paymentAttemptRepository,
  paymentRiskActionRepository,
  realtimeConnectionRepository,
  userRepository,
} from '@bike4mind/database';
import type { UserLinkState } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { hashSignupNetwork } from '@bike4mind/server-utils/auth/signupNetworkSignals';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { adminOwnerSlackRef } from '@server/integrations/slack/subscriptionLifecycle';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

/**
 * Accounts linked to one another through what they paid or signed up with. A shared card
 * fingerprint is a strong link (one cardholder); a shared IP is weak (households, offices, VPN
 * exits share one) and only ever reaches an admin for review. Reads the PaymentAttempt rows the
 * payment-risk screening records (paymentRisk.ts) and the user's signupMeta.
 */

export type LinkVia = 'card' | 'paymentNetwork' | 'signupNetwork';

export type LinkedAccount = UserLinkState & {
  strength: 'strong' | 'weak';
  via: LinkVia[];
  blocked: boolean;
};

// Per link source. A card or network shared by more accounts than this is not one person.
const LINK_LIMIT = 25;

const userRef = (userId: string) => adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: userId });

function isAccountBlocked(user: Parameters<typeof userService.accountBlockReasons>[0]): boolean {
  return userService.accountBlockReasons(user).length > 0;
}

/** Strong links first, then the rest, each newest account first. */
export async function findLinkedAccounts(
  user: { id: string; signupMeta?: { ip?: string | null } | null },
  options: { extraIpHashes?: string[] } = {}
): Promise<LinkedAccount[]> {
  const signupIp = user.signupMeta?.ip ?? null;
  const signupIpHash = hashSignupNetwork(signupIp).ipHash;
  const keys = await paymentAttemptRepository.linkKeysForUser(user.id);
  const ipHashes = [
    ...new Set([...keys.ipHashes, ...(signupIpHash ? [signupIpHash] : []), ...(options.extraIpHashes ?? [])]),
  ];

  const [{ byCard, byNetwork }, bySignupIp] = await Promise.all([
    paymentAttemptRepository.findLinkedUserIds({
      userId: user.id,
      cardFingerprints: keys.cardFingerprints,
      ipHashes,
      limit: LINK_LIMIT,
    }),
    signupIp ? userRepository.findIdsBySignupIp(signupIp, user.id, LINK_LIMIT) : Promise.resolve([]),
  ]);

  const via = new Map<string, Set<LinkVia>>();
  const add = (ids: string[], how: LinkVia) =>
    ids.forEach(id => via.set(id, (via.get(id) ?? new Set<LinkVia>()).add(how)));
  add(byCard, 'card');
  add(byNetwork, 'paymentNetwork');
  add(bySignupIp, 'signupNetwork');
  if (via.size === 0) return [];

  const states = await userRepository.findLinkStatesByIds([...via.keys()]);
  return states
    .map(state => {
      const how = [...(via.get(state.id) ?? [])];
      return {
        ...state,
        strength: how.includes('card') ? ('strong' as const) : ('weak' as const),
        via: how,
        blocked: isAccountBlocked(state),
      };
    })
    .sort(
      (a, b) =>
        Number(b.strength === 'strong') - Number(a.strength === 'strong') ||
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );
}

export async function linkedAccountActionsEnabled(): Promise<boolean> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  return getSettingsValue('paymentRiskLinkedAccountActions', settings, true);
}

/**
 * Locks the account the way a Stripe dispute does (disputePending, API keys off, realtime sessions
 * ended); every block check and the checkout gate read that flag. Idempotent.
 */
export async function lockAccountForPaymentRisk(
  user: Parameters<typeof userService.flagDisputePending>[0]
): Promise<{ deactivatedKeys: boolean }> {
  return userService.flagDisputePending(user, {
    db: {
      users: userRepository,
      userApiKeys: userApiKeyRepository,
      realtimeConnections: realtimeConnectionRepository,
    },
  });
}

export type LinkPropagation = { locked: string[]; review: string[] };

const describeVia = (account: LinkedAccount) =>
  account.via
    .map(how => (how === 'card' ? 'same card' : how === 'paymentNetwork' ? 'same payment IP' : 'same signup IP'))
    .join(', ');

export function formatLinkPropagationAlert(input: {
  sourceUserId: string;
  trigger: string;
  locked: LinkedAccount[];
  review: LinkedAccount[];
}): string {
  const line = (account: LinkedAccount) => `\u2022 ${userRef(account.id)} (${describeVia(account)})`;
  return [
    `:link: *Linked accounts: ${input.trigger}*`,
    `*Source:* ${userRef(input.sourceUserId)}`,
    ...(input.locked.length > 0 ? ['*Locked (same card):*', ...input.locked.map(line)] : []),
    ...(input.review.length > 0 ? ['*Review (shared network only, not locked):*', ...input.review.map(line)] : []),
  ].join('\n');
}

/**
 * Carries a lock on `sourceUserId` to the accounts linked to it: locks the unblocked strong links
 * and posts one alert naming them and the weak links for review. One hop only: an account locked
 * here does not propagate further, so a widely shared network cannot cascade. `key` makes the
 * alert one-shot per trigger. Never throws; the caller's own action has already happened.
 */
export async function propagateAccountRisk(
  input: { sourceUserId: string; trigger: string; key: string },
  logger: Logger
): Promise<LinkPropagation> {
  const none: LinkPropagation = { locked: [], review: [] };
  try {
    if (!(await linkedAccountActionsEnabled())) return none;
    const source = await userRepository.findById(input.sourceUserId);
    if (!source) return none;

    const linked = await findLinkedAccounts(source);
    const toLock = linked.filter(account => account.strength === 'strong' && !account.blocked);
    const review = linked.filter(account => account.strength === 'weak' && !account.blocked);
    for (const account of toLock) await lockAccountForPaymentRisk(account);

    logger.info('[PaymentRisk] propagated account risk to linked accounts', {
      sourceUserId: input.sourceUserId,
      trigger: input.trigger,
      locked: toLock.map(account => account.id),
      review: review.map(account => account.id),
    });
    if (toLock.length === 0 && review.length === 0) return none;
    if (await paymentRiskActionRepository.claimStep(input.key, 'linkedAlert', input.sourceUserId)) {
      await postMessageToSlack(
        formatLinkPropagationAlert({ sourceUserId: input.sourceUserId, trigger: input.trigger, locked: toLock, review })
      );
    }
    return { locked: toLock.map(account => account.id), review: review.map(account => account.id) };
  } catch (error) {
    logger.error('[PaymentRisk] linked-account propagation failed', {
      sourceUserId: input.sourceUserId,
      trigger: input.trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}

/**
 * A payment that went through on a card another, already blocked, account used: locks the payer
 * and alerts once per payment. This is the "next account, same card" case a Radar block on the
 * first account does not cover. Never throws.
 */
export async function lockIfPaidWithBlockedCard(
  input: { userId: string; paymentIntentId: string; cardFingerprints: string[] },
  logger: Logger
): Promise<boolean> {
  try {
    if (input.cardFingerprints.length === 0 || !(await linkedAccountActionsEnabled())) return false;
    const { byCard } = await paymentAttemptRepository.findLinkedUserIds({
      userId: input.userId,
      cardFingerprints: input.cardFingerprints,
      ipHashes: [],
      limit: LINK_LIMIT,
    });
    if (byCard.length === 0) return false;
    const blockedOwner = (await userRepository.findLinkStatesByIds(byCard)).find(isAccountBlocked);
    if (!blockedOwner) return false;

    const payer = await userRepository.findById(input.userId);
    if (!payer || isAccountBlocked(payer)) return false;
    const { deactivatedKeys } = await lockAccountForPaymentRisk(payer);
    logger.warn('[PaymentRisk] locked an account that paid with a blocked account card', {
      userId: input.userId,
      paymentIntentId: input.paymentIntentId,
      blockedUserId: blockedOwner.id,
    });
    if (await paymentRiskActionRepository.claimStep(`card-link:${input.paymentIntentId}`, 'alert', input.userId)) {
      await postMessageToSlack(
        [
          ":lock: *Payment on a blocked account's card: account locked*",
          `*User:* ${userRef(input.userId)}`,
          `*Card also used by:* ${userRef(blockedOwner.id)} (blocked)`,
          `*Payment:* \`${input.paymentIntentId}\``,
          `Account locked${deactivatedKeys ? ', API keys deactivated' : ''}. Refund from Stripe if warranted.`,
        ].join('\n')
      );
    }
    return true;
  } catch (error) {
    logger.error('[PaymentRisk] blocked-card check failed', {
      userId: input.userId,
      paymentIntentId: input.paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

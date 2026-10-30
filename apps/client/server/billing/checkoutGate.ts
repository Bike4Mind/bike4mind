import { adminSettingsRepository, paymentAttemptRepository } from '@bike4mind/database';
import type { INetworkMeta } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { hashSignupNetwork } from '@bike4mind/server-utils/auth/signupNetworkSignals';
import { findLinkedAccounts } from '@server/billing/linkedAccounts';
import { alertFraudBlock } from '@server/billing/fraudBlockAlert';
import { adminUserSlackRef } from '@server/integrations/slack/accountLinks';
import { escapeSlackText } from '@bike4mind/common';

const MINUTE_MS = 60_000;

/** Neutral on purpose: it must not tell a card tester which signal stopped them. */
export const CHECKOUT_REFUSED_MESSAGE = "We couldn't process payments for this account. Please contact support.";

export type CheckoutRefusal =
  | { reason: 'radarBlocks'; scope: 'account' | 'network'; count: number }
  | { reason: 'linkedToBlocked'; linkedUserId: string };

type CheckoutUser = Parameters<typeof findLinkedAccounts>[0];

/**
 * Why a new checkout (credit PaymentIntent, subscription Checkout Session, plan change) must be
 * refused for this user starting from this network, or null when it may go ahead: the account or its
 * network had too many Radar-blocked payments recently, or it is linked by card, signup IP or payment
 * IP to a blocked account. Thresholds are admin settings (paymentRisk*). A blocked account itself is
 * refused earlier, by the route's account-state check, not here.
 */
export async function checkoutRefusal(
  user: CheckoutUser,
  network: Pick<INetworkMeta, 'ip'>
): Promise<CheckoutRefusal | null> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const maxBlocked = getSettingsValue('paymentRiskCheckoutMaxBlockedAttempts', settings, 3);
  const windowMinutes = getSettingsValue('paymentRiskCheckoutBlockedWindowMinutes', settings, 1440);
  const linkedActions = getSettingsValue('paymentRiskLinkedAccountActions', settings, true);
  const requestIpHash = hashSignupNetwork(network.ip).ipHash;

  if (maxBlocked > 0) {
    const blocked = await paymentAttemptRepository.countRadarBlocked({
      userId: user.id,
      ipHash: requestIpHash,
      since: new Date(Date.now() - windowMinutes * MINUTE_MS),
    });
    if (blocked.account >= maxBlocked) return { reason: 'radarBlocks', scope: 'account', count: blocked.account };
    if (blocked.network !== null && blocked.network >= maxBlocked) {
      return { reason: 'radarBlocks', scope: 'network', count: blocked.network };
    }
  }

  if (linkedActions) {
    const linked = await findLinkedAccounts(user, { extraIpHashes: requestIpHash ? [requestIpHash] : [] });
    const blockedLink = linked.find(account => account.blocked);
    if (blockedLink) return { reason: 'linkedToBlocked', linkedUserId: blockedLink.id };
  }
  return null;
}

export function describeCheckoutRefusal(refusal: CheckoutRefusal): string {
  if (refusal.reason === 'radarBlocks') {
    return `${refusal.count} Radar-blocked payments from this ${refusal.scope} recently`;
  }
  return `linked by card or network to blocked account ${adminUserSlackRef(refusal.linkedUserId)}`;
}

/**
 * Throws the neutral ForbiddenError when checkoutRefusal refuses. A failure to evaluate lets the
 * checkout through (logged): Radar still screens the payment, and a database hiccup must not stop
 * every purchase.
 */
export async function assertCheckoutAllowed(
  user: CheckoutUser,
  network: Pick<INetworkMeta, 'ip'>,
  logger: Logger,
  checkout: string
): Promise<void> {
  let refusal: CheckoutRefusal | null;
  try {
    refusal = await checkoutRefusal(user, network);
  } catch (error) {
    logger.error('[PaymentRisk] checkout gate failed; allowing checkout', {
      userId: user.id,
      checkout,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!refusal) return;
  logger.warn('[PaymentRisk] checkout refused', { userId: user.id, checkout, ...refusal });
  await alertFraudBlock({
    kind: 'checkoutRefused',
    userId: user.id,
    details: [`*Checkout:* ${escapeSlackText(checkout)}`, `*Why:* ${describeCheckoutRefusal(refusal)}`],
  });
  throw new ForbiddenError(CHECKOUT_REFUSED_MESSAGE);
}

import { BadRequestError, InternalServerError, isPricePerCreditBelowFloor } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { APP_NAME } from '@client/config/general';
import { z } from 'zod';
import { CREDIT_PACKAGES } from './constants';
import { packageSchema, perCreditSchema } from './schemas';
import { PaymentDetails } from './types';

// Stripe's minimum charge for a USD payment.
const STRIPE_MIN_CHARGE_CENTS = 50;

export async function handlePerCreditTransaction(
  { credits }: z.infer<typeof perCreditSchema>,
  { userId, logger }: { userId: string; logger: Pick<Logger, 'error'> }
): Promise<PaymentDetails> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const pricePerCredit = getSettingsValue('pricePerCredit', settings);

  if (pricePerCredit === undefined) {
    throw new InternalServerError('Credit pricing not configured (pricePerCredit)');
  }

  // The admin save refuses this, so reaching it means a value stored before the floor existed or
  // written to the database directly.
  if (isPricePerCreditBelowFloor(pricePerCredit)) {
    logger.error('[CreditPurchase] Configured pricePerCredit is below the floor; refusing purchase', { userId });
    throw new InternalServerError('Credit pricing is misconfigured. Please contact support.');
  }

  // Rounded up so a fractional-cent total never sells credits below the configured price. The
  // epsilon absorbs float noise on an exact total (0.0006 * 1000 * 100 is 60.00000000000001).
  const amount = Math.ceil(pricePerCredit * credits * 100 - 1e-6); // Stripe expects the amount in cents
  if (amount < STRIPE_MIN_CHARGE_CENTS) {
    const minCredits = Math.floor((STRIPE_MIN_CHARGE_CENTS - 1 + 1e-6) / (pricePerCredit * 100)) + 1;
    throw new BadRequestError(
      `A credit purchase must total at least $${STRIPE_MIN_CHARGE_CENTS / 100}. Buy at least ${minCredits} credits.`
    );
  }

  return {
    amount,
    description: `${APP_NAME} credits (${credits.toLocaleString()})`,
    metadata: {
      credits: credits,
      pricePerCredit: pricePerCredit.toString(),
    },
  };
}

export async function handlePackageTransaction({ packageId }: z.infer<typeof packageSchema>): Promise<PaymentDetails> {
  const packageInfo = CREDIT_PACKAGES[packageId];

  return {
    amount: packageInfo.price * 100, // Stripe expects the amount in cents
    description: `${APP_NAME} credits package (${packageInfo.credits.toLocaleString()})`,
    metadata: {
      credits: packageInfo.credits,
      packageId: packageId,
    },
  };
}

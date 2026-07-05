import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue, InternalServerError } from '@bike4mind/utils';
import { APP_NAME } from '@client/config/general';
import { z } from 'zod';
import { CREDIT_PACKAGES } from './constants';
import { packageSchema, perCreditSchema } from './schemas';
import { PaymentDetails } from './types';

export async function handlePerCreditTransaction({
  credits,
}: z.infer<typeof perCreditSchema>): Promise<PaymentDetails> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const pricePerCredit = getSettingsValue('pricePerCredit', settings);

  if (pricePerCredit === undefined) {
    throw new InternalServerError('Credit pricing not configured (pricePerCredit)');
  }

  return {
    amount: pricePerCredit * credits * 100, // Stripe expects the amount in cents
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

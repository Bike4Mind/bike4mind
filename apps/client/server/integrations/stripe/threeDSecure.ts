import { adminSettingsRepository } from '@bike4mind/database';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `'challenge'` asks the issuer to always step up; a passed challenge usually moves fraud liability to it. */
const CHALLENGE_CARD_OPTIONS = {
  payment_method_options: { card: { request_three_d_secure: 'challenge' } },
} as const;

type WarnLogger = { warn: (message: string, meta?: Record<string, unknown>) => void };

export type FirstPurchaseInput = {
  /** The Stripe customer that will be charged; missing means it has never paid. */
  stripeCustomerId: string | null | undefined;
  /** When the paying account (user or org) was created; missing counts as brand new. */
  accountCreatedAt: Date | string | null | undefined;
  /** Accounts younger than this many days are always treated as first purchases. 0 disables the window. */
  newAccountDays: number;
  now?: Date;
};

/** True when the customer has a succeeded, undisputed charge in its 100 most recent charges. */
export async function hasSucceededCharge(stripeCustomerId: string): Promise<boolean> {
  const charges = await stripe.charges.list({ customer: stripeCustomerId, limit: 100 });
  return charges.data.some(charge => charge.status === 'succeeded' && !charge.disputed);
}

function isWithinNewAccountWindow({ accountCreatedAt, newAccountDays, now = new Date() }: FirstPurchaseInput): boolean {
  if (newAccountDays <= 0) return false;
  if (!accountCreatedAt) return true;
  const createdAtMs = new Date(accountCreatedAt).getTime();
  if (Number.isNaN(createdAtMs)) return true;
  return now.getTime() - createdAtMs < newAccountDays * DAY_MS;
}

/**
 * A purchase is a "first purchase" when the paying account is younger than `newAccountDays`,
 * or when its Stripe customer has never had a succeeded charge. The age window catches a
 * second stolen card tried on a fresh account right after the first one went through.
 */
export async function isFirstPurchase(input: FirstPurchaseInput): Promise<boolean> {
  if (isWithinNewAccountWindow(input)) return true;
  if (!input.stripeCustomerId) return true;
  return !(await hasSucceededCharge(input.stripeCustomerId));
}

/**
 * Card options to spread into `checkout.sessions.create` / `paymentIntents.create`: a forced
 * 3-D Secure challenge on a first purchase while `requireThreeDSecureOnFirstPurchase` is on,
 * nothing otherwise. Fails closed: if Stripe cannot be asked about prior charges, 3DS is requested.
 */
export async function firstPurchaseCardOptions(
  input: Omit<FirstPurchaseInput, 'newAccountDays'>,
  logger: WarnLogger
): Promise<typeof CHALLENGE_CARD_OPTIONS | Record<string, never>> {
  if ((await adminSettingsRepository.getSettingsValue('requireThreeDSecureOnFirstPurchase')) === false) {
    return {};
  }
  const newAccountDays = (await adminSettingsRepository.getSettingsValue('threeDSecureNewAccountDays')) ?? 0;

  try {
    return (await isFirstPurchase({ ...input, newAccountDays })) ? CHALLENGE_CARD_OPTIONS : {};
  } catch (error) {
    logger.warn('[ThreeDSecure] Could not read prior charges; requesting 3-D Secure', {
      stripeCustomerId: input.stripeCustomerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return CHALLENGE_CARD_OPTIONS;
  }
}

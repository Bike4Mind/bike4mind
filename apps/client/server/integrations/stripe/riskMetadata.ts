import type { ISignupMeta } from '@bike4mind/common';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import type Stripe from 'stripe';

const HOUR_MS = 60 * 60 * 1000;

type WarnLogger = { warn: (message: string, meta?: Record<string, unknown>) => void };

/** The slice of a user document the metadata is built from; callers pass `req.user`. */
export type RiskMetadataSource = {
  createdAt?: Date | string | null;
  signupMeta?: Pick<ISignupMeta, 'asn' | 'country' | 'isDatacenter'> | null;
};

/**
 * Signup network facts, as Stripe metadata. The keys are the contract Radar rules are written
 * against (`::signup_is_datacenter::` on a PaymentIntent, `::customer:signup_is_datacenter::` on
 * a Customer), so renaming one silently disables every rule that reads it. Never the IP, the
 * user agent or the email: metadata is visible to anyone with Dashboard access.
 */
export type SignupNetworkMetadata = {
  signup_asn?: string;
  signup_is_datacenter?: 'true' | 'false';
  signup_country?: string;
};

export type AccountAgeMetadata = {
  /** Whole hours since the account was created, rounded down. */
  account_age_hours: string;
};

export type PaymentRiskMetadata = AccountAgeMetadata & SignupNetworkMetadata;

/** A field is left out, not sent empty, when signup capture did not record it. */
export function signupNetworkMetadata(user: RiskMetadataSource): SignupNetworkMetadata {
  const meta = user.signupMeta;
  if (!meta) return {};
  return {
    ...(typeof meta.asn === 'number' && { signup_asn: String(meta.asn) }),
    ...(typeof meta.isDatacenter === 'boolean' && { signup_is_datacenter: meta.isDatacenter ? 'true' : 'false' }),
    ...(meta.country && { signup_country: meta.country }),
  };
}

/** An account with no readable creation time counts as brand new, as the 3-D Secure window does. */
export function accountAgeMetadata(user: RiskMetadataSource, now: Date = new Date()): AccountAgeMetadata {
  if (!user.createdAt) return { account_age_hours: '0' };
  const createdAtMs = new Date(user.createdAt).getTime();
  if (Number.isNaN(createdAtMs)) return { account_age_hours: '0' };
  const hours = Math.floor((now.getTime() - createdAtMs) / HOUR_MS);
  return { account_age_hours: String(Math.max(0, hours)) };
}

/** Everything a PaymentIntent created for this user carries, so a rule can read it without a Customer lookup. */
export function paymentRiskMetadata(user: RiskMetadataSource, now?: Date): PaymentRiskMetadata {
  return { ...accountAgeMetadata(user, now), ...signupNetworkMetadata(user) };
}

/**
 * Add the signup fields to a Stripe Customer that was created before they were sent. Invoice
 * charges (subscription renewals) carry no PaymentIntent metadata of ours, so the Customer is
 * where rules read the signup network for those; `customers.update` merges metadata keys, so
 * nothing already on the customer is touched. Best effort: a failure here is logged, never
 * surfaced, because the purchase must not depend on an enrichment call.
 */
export async function backfillCustomerSignupMetadata(
  input: {
    customerId: string;
    user: RiskMetadataSource;
    /** Pass the customer's current metadata when it was already fetched, to skip a redundant update. */
    existingMetadata?: Stripe.Metadata | null;
  },
  logger: WarnLogger
): Promise<void> {
  const metadata = signupNetworkMetadata(input.user);
  const keys = Object.keys(metadata) as Array<keyof SignupNetworkMetadata>;
  if (keys.length === 0) return;
  if (input.existingMetadata && keys.every(key => input.existingMetadata?.[key] === metadata[key])) return;

  try {
    await stripe.customers.update(input.customerId, { metadata });
  } catch (error) {
    logger.warn('[RiskMetadata] Could not add signup metadata to the Stripe customer', {
      stripeCustomerId: input.customerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

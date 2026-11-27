import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import type Stripe from 'stripe';

export type TermsConsentSessionParams = Pick<
  Stripe.Checkout.SessionCreateParams,
  'consent_collection' | 'client_reference_id'
>;

/** Whether `requireCheckoutTermsConsent` asks buyers to accept the Terms of Service at checkout. */
export async function isCheckoutTermsConsentRequired(): Promise<boolean> {
  return (await adminSettingsRepository.getSettingsValue('requireCheckoutTermsConsent')) === true;
}

/**
 * Spread into a subscription `checkout.sessions.create`: a required Terms of Service checkbox while
 * the setting is on. `client_reference_id` names the buyer so the `checkout.session.completed`
 * webhook can record the acceptance. Stripe rejects the session unless its dashboard has a terms URL.
 */
export async function termsConsentSessionParams(userId: string): Promise<TermsConsentSessionParams> {
  if (!(await isCheckoutTermsConsentRequired())) {
    return {};
  }
  return { consent_collection: { terms_of_service: 'required' }, client_reference_id: userId };
}

/**
 * Spread into a credit-pack PaymentIntent's metadata. PaymentIntents have no consent collection,
 * so the client sends `acceptedTerms` from its own checkbox; `payment_intent.succeeded` records the version.
 */
export async function creditPurchaseTermsMetadata(
  acceptedTerms: boolean | undefined
): Promise<{ termsAcceptedVersion?: string }> {
  if (!(await isCheckoutTermsConsentRequired())) {
    return {};
  }
  if (acceptedTerms !== true) {
    throw new BadRequestError('Accept the Terms of Service to buy credits.');
  }
  return { termsAcceptedVersion: CURRENT_POLICY_VERSION };
}

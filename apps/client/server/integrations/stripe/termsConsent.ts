import { adminSettingsRepository } from '@bike4mind/database';
import type Stripe from 'stripe';

export type TermsConsentSessionParams = Pick<
  Stripe.Checkout.SessionCreateParams,
  'consent_collection' | 'client_reference_id'
>;

/**
 * Spread into a subscription `checkout.sessions.create`: a required Terms of Service checkbox while
 * `requireCheckoutTermsConsent` is on, nothing otherwise. `client_reference_id` names the buyer so
 * the `checkout.session.completed` webhook can record the acceptance on that account. Off by
 * default because Stripe rejects the session unless the account has a terms URL in its dashboard.
 */
export async function termsConsentSessionParams(userId: string): Promise<TermsConsentSessionParams> {
  if ((await adminSettingsRepository.getSettingsValue('requireCheckoutTermsConsent')) !== true) {
    return {};
  }
  return { consent_collection: { terms_of_service: 'required' }, client_reference_id: userId };
}

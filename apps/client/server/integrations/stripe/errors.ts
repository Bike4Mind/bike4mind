import { BadRequestError } from '@bike4mind/common';
import Stripe from 'stripe';

/**
 * Rethrow a Stripe error, turning a rejection into a 400.
 *
 * A StripeError exposes `statusCode`, not `status`, so the shared error handler
 * cannot map it and reports a 500 - which trips the LiveOps alarm for what is a
 * user-facing rejection. Only a real rejection is remapped: an auth, rate limit
 * or Stripe-side fault keeps its 5xx so it still alarms.
 *
 * Imports the `stripe` package for the error class only, never the configured
 * client, so a route test's mock of `@server/integrations/stripe/stripe` need
 * not reach the real thing to exercise this.
 */
export function rethrowStripeRejection(error: unknown, message: string): never {
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    throw new BadRequestError(`${message}: ${error.message}`);
  }
  throw error;
}

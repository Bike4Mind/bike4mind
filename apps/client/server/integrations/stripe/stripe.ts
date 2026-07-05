import { organizationRepository, userRepository } from '@bike4mind/database';
import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import Stripe from 'stripe';

/**
 * Check if Stripe is configured with valid credentials.
 * Returns false if STRIPE_SECRET_KEY is a placeholder or not set.
 */
export function isStripeConfigured(): boolean {
  return !isPlaceholderValue(Config.STRIPE_SECRET_KEY);
}

// Lazy-initialized Stripe instance
let _stripe: Stripe | null = null;

/**
 * Get the Stripe SDK instance.
 * Throws an error if Stripe is not configured.
 * Uses lazy initialization to prevent crashes on module load.
 */
export function getStripe(): Stripe {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable payment features.');
  }
  if (!_stripe) {
    _stripe = new Stripe(Config.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/**
 * Backward-compatible Stripe instance export.
 * Uses a Proxy to lazily initialize and throw helpful errors if not configured.
 */
export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    return getStripe()[prop as keyof Stripe];
  },
});

export enum CustomerType {
  User = 'User',
  Organization = 'Organization',
}

export async function createCustomer({ email, name, type }: { email: string; name: string; type: CustomerType }) {
  const customer = await getStripe().customers.create({
    email,
    name,
    metadata: {
      type,
      stage: Config.STAGE,
    },
  });
  return customer;
}

export async function customerExists(customerId: string) {
  const customer = await getStripe().customers.retrieve(customerId);
  if (customer.deleted) {
    return true;
  }

  // If no `type` is set, this is a legacy user customer. So we check if the customer is associated with a user.
  if (!customer.metadata.type || customer.metadata.type === CustomerType.User) {
    const user = await userRepository.findByStripeCustomerId(customerId);
    return !!user;
  }

  // Otherwise, check if customer is associated with an organization
  const organization = await organizationRepository.findByStripeCustomerId(customerId);
  return !!organization;
}

export const config = {
  api: {
    bodyParser: false, // Disallow body parsing, we need raw body for stripe to verify body tampers
    externalResolver: true,
  },
};

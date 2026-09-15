import { Config, isDevelopment } from '@server/utils/config';
import { InternalServerError } from '@server/utils/errors';
import { RequestHandler } from 'express';
import { z } from 'zod';

interface RequireStripeWebhookOptions {}

const webhookSecretSchema = z.string().transform(val => {
  const trimmed = val.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : val;
});

/**
 * Ensures the Stripe webhook secret is configured; see README.md for details.
 * Skipped in development/local environments.
 */
export const requireStripeWebhook =
  (options: RequireStripeWebhookOptions = {}): RequestHandler =>
  async (req, res, next) => {
    // Skip webhook secret validation in development/local environments
    if (isDevelopment()) {
      req.logger?.warn?.('Skipping Stripe webhook secret validation in development mode');
      next();
      return;
    }

    const webhookSecret = webhookSecretSchema.parse(Config.STRIPE_WEBHOOK_SECRET);
    if (!webhookSecret) {
      next(new InternalServerError('Stripe webhook secret is not configured'));
    }

    if (!Config.STRIPE_PUBLISHABLE_KEY || !Config.STRIPE_SECRET_KEY) {
      next(new InternalServerError('Stripe publishable or secret key is not configured'));
    }

    next();
  };

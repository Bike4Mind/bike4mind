import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { adminSettingsRepository } from '@bike4mind/database';
import { isEnforceCreditsLocked } from '@bike4mind/common';
import { SUBSCRIPTION_PLANS } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { Config, isDevelopment } from '@bike4mind/server-utils/utils/config';
import type { Request, Response } from 'express';

function configured(value: string | undefined): boolean {
  return !!value?.trim() && !['null', 'not-configured'].includes(value.trim().toLowerCase());
}

const personalCatalog = baseApi({ auth: 'jwtOnly' }).get(async (_req, res) => {
  const billingEnabled =
    (isEnforceCreditsLocked() || (await adminSettingsRepository.getSettingsValue('enforceCredits')) === true) &&
    configured(Config.STRIPE_SECRET_KEY) &&
    configured(Config.STRIPE_PUBLISHABLE_KEY) &&
    (isDevelopment() || configured(Config.STRIPE_WEBHOOK_SECRET));
  if (!billingEnabled) return res.json({ billingEnabled: false, plans: [] });
  const prices = await stripe.prices.list({ active: true, limit: 100 });
  const plans = SUBSCRIPTION_PLANS.filter(plan => !plan.hidden && plan.name === 'Professional').flatMap(plan => {
    const price = prices.data.find(candidate => candidate.id === plan.priceId);
    const interval = plan.interval === 'monthly' ? 'month' : 'year';
    if (
      !price ||
      !price.active ||
      price.currency !== 'usd' ||
      price.type !== 'recurring' ||
      price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1 ||
      price.unit_amount === null ||
      !Number.isSafeInteger(price.unit_amount) ||
      price.unit_amount < 0 ||
      price.billing_scheme !== 'per_unit'
    )
      return [];
    return [
      {
        priceId: plan.priceId,
        name: plan.name,
        description: plan.description,
        credits: plan.credits,
        interval: plan.interval,
        features: plan.features,
        priceCents: price.unit_amount,
        currency: 'usd',
      },
    ];
  });
  return res.json({ billingEnabled, plans });
});

const handler = baseApi().get(async (req, res) => {
  const prices = await stripe.prices.list({
    active: true,
    limit: 100,
  });

  return res.json(prices.data);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default function subscriptionPlans(req: Request, res: Response) {
  // The desktop catalog is first-party-only; the legacy price-list response is unchanged.
  return req.query.catalog === 'personal' ? personalCatalog(req, res) : handler(req, res);
}

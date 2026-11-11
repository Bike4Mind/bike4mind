import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { adminSettingsRepository } from '@bike4mind/database';
import { getWebsiteUrl, isEnforceCreditsLocked, WEBSITE_URL } from '@bike4mind/common';
import { SUBSCRIPTION_PLANS } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { Config, isDevelopment } from '@bike4mind/server-utils/utils/config';
import type { Request, Response } from 'express';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { isCheckoutTermsConsentRequired } from '@server/integrations/stripe/termsConsent';
import { z } from 'zod';
import type Stripe from 'stripe';

function configured(value: string | undefined): boolean {
  return !!value?.trim() && !['null', 'not-configured'].includes(value.trim().toLowerCase());
}

async function readConfiguredPrice(
  priceId: string,
  logger: { warn(message: string): void }
): Promise<Stripe.Price | null> {
  try {
    return await stripe.prices.retrieve(priceId);
  } catch (error) {
    if (!z.object({ code: z.literal('resource_missing') }).safeParse(error).success) throw error;
    logger.warn(`Configured subscription price ${priceId} no longer exists`);
    return null;
  }
}

const desktopCatalog = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const creditPackages = { creditPackages: Object.values(CREDIT_PACKAGES) };
  const billingEnabled =
    (isEnforceCreditsLocked() || (await adminSettingsRepository.getSettingsValue('enforceCredits')) === true) &&
    configured(Config.STRIPE_SECRET_KEY) &&
    configured(Config.STRIPE_PUBLISHABLE_KEY) &&
    (isDevelopment() || configured(Config.STRIPE_WEBHOOK_SECRET));
  if (!billingEnabled) {
    return res.json({ billingEnabled: false, termsConsentRequired: false, plans: [], ...creditPackages });
  }
  const termsConsentRequired = await isCheckoutTermsConsentRequired();
  // The desktop app has no build-time website URL, so the server names the page the checkbox links to.
  const termsUrl = termsConsentRequired && WEBSITE_URL ? getWebsiteUrl('terms-of-service') : null;
  const plans = await Promise.all(
    SUBSCRIPTION_PLANS.filter(plan => !plan.hidden && plan.name === 'Professional' && configured(plan.priceId)).map(
      async plan => {
        const price = await readConfiguredPrice(plan.priceId, req.logger);
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
          return null;
        return {
          priceId: plan.priceId,
          name: plan.name,
          description: plan.description,
          credits: plan.credits,
          interval: plan.interval,
          features: plan.features,
          priceCents: price.unit_amount,
          currency: 'usd',
        };
      }
    )
  );
  return res.json({
    billingEnabled,
    termsConsentRequired,
    termsUrl,
    plans: plans.filter(plan => plan !== null),
    ...creditPackages,
  });
});

const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
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
  return req.query.catalog === 'desktop' ? desktopCatalog(req, res) : handler(req, res);
}

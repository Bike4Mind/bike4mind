import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  retrieve: vi.fn(),
  setting: vi.fn(),
  locked: vi.fn(),
  development: vi.fn(),
  config: {
    STRIPE_SECRET_KEY: 'configured',
    STRIPE_PUBLISHABLE_KEY: 'configured',
    STRIPE_WEBHOOK_SECRET: 'configured',
  },
  plans: [
    {
      priceId: 'price_stage',
      name: 'Professional',
      interval: 'monthly',
      credits: 50000,
      description: 'All models',
      features: ['Rollover'],
      hidden: false,
    },
  ],
  authModes: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.authModes.push(options);
    return { get: (handler: unknown) => handler };
  },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { prices: { list: mocks.list, retrieve: mocks.retrieve } },
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { getSettingsValue: mocks.setting } }));
vi.mock('@bike4mind/common', () => ({
  isEnforceCreditsLocked: mocks.locked,
  MIN_PRICE_PER_CREDIT_USD: 0.0006,
  WEBSITE_URL: 'https://site.example',
  getWebsiteUrl: (path: string) => `https://site.example/${path}`,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config, isDevelopment: mocks.development }));
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({ SUBSCRIPTION_PLANS: mocks.plans }));

import handler from '../subscription-plans';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { packageSchema } from '@client/lib/credits/schemas';

const invoke = handler as (req: unknown, res: unknown) => Promise<unknown>;

const price = {
  id: 'price_stage',
  active: true,
  currency: 'usd',
  unit_amount: 3000,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1 },
  billing_scheme: 'per_unit',
};

async function request(desktop = true) {
  const { req, res } = createMocks({ method: 'GET', query: desktop ? { catalog: 'desktop' } : {} });
  (req as Record<string, unknown>).logger = { warn: vi.fn() };
  await invoke(req, res);
  return res._getJSONData();
}

describe('subscription plan catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ data: [price] });
    mocks.retrieve.mockImplementation(async id => {
      if (id !== price.id) throw { code: 'resource_missing' };
      return price;
    });
    mocks.setting.mockResolvedValue(true);
    mocks.locked.mockReturnValue(false);
    mocks.development.mockReturnValue(false);
    mocks.config.STRIPE_SECRET_KEY = 'configured';
    mocks.config.STRIPE_PUBLISHABLE_KEY = 'configured';
    mocks.config.STRIPE_WEBHOOK_SECRET = 'configured';
    mocks.plans[0].priceId = 'price_stage';
    mocks.plans[0].hidden = false;
  });

  it('keeps legacy prices unchanged and registers both handlers as JWT-only', async () => {
    expect(mocks.authModes).toEqual([{ auth: 'jwtOnly' }, { auth: 'jwtOnly' }]);
    expect(await request(false)).toEqual([price]);
    expect(mocks.setting).not.toHaveBeenCalled();
  });

  it('includes configured credit packages in the desktop catalog', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { catalog: 'desktop' } });
    await invoke(req, res);
    expect(res._getJSONData().creditPackages).toEqual(Object.values(CREDIT_PACKAGES));
    expect(Object.values(CREDIT_PACKAGES).map(pack => pack.id)).toEqual([
      'package_25k',
      'package_usd50',
      'package_usd100',
    ]);
    for (const pack of Object.values(CREDIT_PACKAGES)) {
      expect(packageSchema.safeParse({ transactionType: 'package', packageId: pack.id }).success).toBe(true);
    }
  });

  it('reports whether credit purchases need terms consent, and never while billing is off', async () => {
    mocks.setting.mockImplementation(async (key: string) => key !== 'requireCheckoutTermsConsent');
    expect(await request()).toMatchObject({ termsConsentRequired: false, termsUrl: null });

    mocks.setting.mockResolvedValue(true);
    expect(await request()).toMatchObject({
      termsConsentRequired: true,
      termsUrl: 'https://site.example/terms-of-service',
    });

    mocks.config.STRIPE_SECRET_KEY = '';
    expect(await request()).toMatchObject({ billingEnabled: false, termsConsentRequired: false });
  });

  it('retrieves configured plans independently of the first page of unrelated prices', async () => {
    mocks.list.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, index) => ({ ...price, id: `price_other_${index}` })),
      has_more: true,
    });
    mocks.retrieve.mockResolvedValue(price);
    expect((await request()).plans).toEqual([expect.objectContaining({ priceId: 'price_stage' })]);
  });

  it('joins only configured public personal plan metadata to live Stripe prices', async () => {
    expect(await request()).toEqual({
      billingEnabled: true,
      termsConsentRequired: true,
      termsUrl: 'https://site.example/terms-of-service',
      creditPackages: Object.values(CREDIT_PACKAGES),
      plans: [
        {
          priceId: 'price_stage',
          name: 'Professional',
          description: 'All models',
          interval: 'monthly',
          credits: 50000,
          features: ['Rollover'],
          priceCents: 3000,
          currency: 'usd',
        },
      ],
    });
  });

  it('uses the server-resolved price, independent of any caller-supplied stage', async () => {
    mocks.plans[0].priceId = 'price_other_stage';
    expect(await request()).toMatchObject({ billingEnabled: true, plans: [] });
    mocks.retrieve.mockResolvedValue({ ...price, id: 'price_other_stage' });
    expect((await request()).plans[0].priceId).toBe('price_other_stage');
  });

  it('surfaces a failed price read instead of presenting an empty catalog', async () => {
    mocks.retrieve.mockRejectedValue(new Error('Stripe unavailable'));
    await expect(request()).rejects.toThrow('Stripe unavailable');
  });

  it('returns no plans when price configuration is absent or hidden', async () => {
    mocks.plans[0].priceId = '';
    expect((await request()).plans).toEqual([]);
    mocks.plans[0].priceId = 'price_stage';
    mocks.plans[0].hidden = true;
    expect((await request()).plans).toEqual([]);
  });

  it.each([
    { active: false },
    { currency: 'eur' },
    { unit_amount: null },
    { unit_amount: -1 },
    { type: 'one_time' },
    { recurring: null },
    { recurring: { interval: 'year', interval_count: 1 } },
    { recurring: { interval: 'month', interval_count: 2 } },
    { billing_scheme: 'tiered' },
  ])('omits incompatible or unavailable Stripe price %j', async patch => {
    mocks.retrieve.mockResolvedValue({ ...price, ...patch });
    expect((await request()).plans).toEqual([]);
  });

  it('does not call Stripe when billing is disabled', async () => {
    mocks.setting.mockResolvedValue(false);
    expect(await request()).toMatchObject({ billingEnabled: false, plans: [] });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('honors hosted credit enforcement', async () => {
    mocks.setting.mockResolvedValue(false);
    mocks.locked.mockReturnValue(true);
    expect((await request()).billingEnabled).toBe(true);
  });

  it.each(['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'] as const)(
    'does not offer billing without %s',
    async key => {
      mocks.config[key] = '';
      expect(await request()).toMatchObject({ billingEnabled: false, plans: [] });
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.retrieve).not.toHaveBeenCalled();
    }
  );

  it.each(['null', 'not-configured', '   '])('rejects placeholder billing configuration %s', async value => {
    mocks.config.STRIPE_WEBHOOK_SECRET = value;
    expect(await request()).toMatchObject({ billingEnabled: false, plans: [] });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});

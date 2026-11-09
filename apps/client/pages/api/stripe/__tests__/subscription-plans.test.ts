import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
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
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({ stripe: { prices: { list: mocks.list } } }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { getSettingsValue: mocks.setting } }));
vi.mock('@bike4mind/common', () => ({ isEnforceCreditsLocked: mocks.locked }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config, isDevelopment: mocks.development }));
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({ SUBSCRIPTION_PLANS: mocks.plans }));

import handler from '../subscription-plans';

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

async function request(personal = true) {
  const { req, res } = createMocks({ method: 'GET', query: personal ? { catalog: 'personal' } : {} });
  await invoke(req, res);
  return res._getJSONData();
}

describe('subscription plan catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ data: [price] });
    mocks.setting.mockResolvedValue(true);
    mocks.locked.mockReturnValue(false);
    mocks.development.mockReturnValue(false);
    mocks.config.STRIPE_SECRET_KEY = 'configured';
    mocks.config.STRIPE_PUBLISHABLE_KEY = 'configured';
    mocks.config.STRIPE_WEBHOOK_SECRET = 'configured';
    mocks.plans[0].priceId = 'price_stage';
    mocks.plans[0].hidden = false;
  });

  it('keeps legacy prices unchanged and registers catalog as JWT-only', async () => {
    expect(mocks.authModes).toContainEqual({ auth: 'jwtOnly' });
    expect(await request(false)).toEqual([price]);
    expect(mocks.setting).not.toHaveBeenCalled();
  });

  it('joins only configured public personal plan metadata to live Stripe prices', async () => {
    expect(await request()).toEqual({
      billingEnabled: true,
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
    expect(await request()).toEqual({ billingEnabled: true, plans: [] });
    mocks.list.mockResolvedValue({ data: [{ ...price, id: 'price_other_stage' }] });
    expect((await request()).plans[0].priceId).toBe('price_other_stage');
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
    mocks.list.mockResolvedValue({ data: [{ ...price, ...patch }] });
    expect((await request()).plans).toEqual([]);
  });

  it('does not call Stripe when billing is disabled', async () => {
    mocks.setting.mockResolvedValue(false);
    expect(await request()).toEqual({ billingEnabled: false, plans: [] });
    expect(mocks.list).not.toHaveBeenCalled();
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
      expect(await request()).toEqual({ billingEnabled: false, plans: [] });
      expect(mocks.list).not.toHaveBeenCalled();
    }
  );

  it.each(['null', 'not-configured', '   '])('rejects placeholder billing configuration %s', async value => {
    mocks.config.STRIPE_WEBHOOK_SECRET = value;
    expect(await request()).toEqual({ billingEnabled: false, plans: [] });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

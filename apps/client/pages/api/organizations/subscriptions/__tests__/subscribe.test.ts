// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';

// baseApi: unwrap the chain so handler.post(fn) just returns fn, and .use() is a no-op.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    post: (fn: unknown) => fn,
  }),
}));

// requireStripeWebhook is applied via .use() (dropped by the baseApi mock); stub the
// factory so importing the handler doesn't touch real webhook config.
vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Deliberately NOT mocking the error classes: the real BadRequestError carries statusCode
// 400, which lets the rejection test assert the status the client would actually receive
// rather than only the message. Imported from @bike4mind/common, the sole declaration site -
// @bike4mind/utils is a @deprecated re-export (same class identity, non-canonical path).
import { BadRequestError, HttpStatus } from '@bike4mind/common';

const mockOrgFindById = vi.fn();
const mockOrgUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => mockOrgFindById(...args),
    update: (...args: unknown[]) => mockOrgUpdate(...args),
  },
}));

const mockFindByPriceIdAndOwner = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByPriceIdAndOwner: (...args: unknown[]) => mockFindByPriceIdAndOwner(...args),
  },
}));

// Drive the origin verdict per test. Keep the REAL appendSuccessParams so the success_url
// this route builds is actually asserted rather than mocked into agreement.
const mockIsAllowedCallbackOrigin = vi.fn();
vi.mock('@server/integrations/stripe/callbackUrl', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/stripe/callbackUrl')>();
  return { ...actual, isAllowedCallbackOrigin: (...args: unknown[]) => mockIsAllowedCallbackOrigin(...args) };
});
vi.mock('@server/utils/config', () => ({ Config: { STAGE: 'test' } }));

const mockSessionsCreate = vi.fn();
const mockCreateCustomer = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  CustomerType: { User: 'User', Organization: 'Organization' },
  stripe: {
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  },
}));

import handler from '../subscribe';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const CALLBACK_URL = 'https://app.example.com/cb';

function makeReq(callbackUrl = CALLBACK_URL) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = {
    priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
    quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
    organizationId: 'org_1',
    callbackUrl,
  };
  (req as Record<string, unknown>).user = { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' };
  return { req, res };
}

describe('POST /api/organizations/subscriptions/subscribe - callbackUrl origin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockFindByPriceIdAndOwner.mockResolvedValue(null); // no active org subscription
    // No stripeCustomerId: the route must therefore run createCustomer AND persist via
    // organizationRepository.update, which is what makes the "no side effect on rejection"
    // assertions below capable of failing. With a customer id pre-set the route skipped that
    // whole branch, so those assertions held whether the guard ran or not.
    mockOrgFindById.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  it('rejects a callbackUrl on a disallowed origin', async () => {
    // The guard is the only thing between an org callbackUrl and an open redirect off
    // Stripe's hosted checkout page, where the redirect wears Stripe's brand.
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('https://attacker.example.net/phish');

    // Asserted in ONE throw: message and status together, so the handler runs once. It used
    // to be invoked twice for these two assertions - harmless only while nothing sits above
    // the guard, since a second run would double every mock's call log below.
    // `constructor:` rather than `toBeInstanceOf` is deliberate - it pins the exact class,
    // where toBeInstanceOf would also accept a SUBCLASS of BadRequestError carrying a
    // different status. Do not "simplify" it.
    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'callbackUrl must point to the deployed application origin',
    });

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith('https://attacker.example.net/phish');
  });

  it('runs the guard before any lookup or Stripe side effect', async () => {
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('https://attacker.example.net/phish');

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow();

    expect(mockFindByPriceIdAndOwner).not.toHaveBeenCalled();
    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockOrgUpdate).not.toHaveBeenCalled(); // the DB write the guard now provably precedes
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('passes an allowed-origin callbackUrl through to the checkout session', async () => {
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith(CALLBACK_URL);
    expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
    expect(mockOrgUpdate).toHaveBeenCalledTimes(1);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ sessionUrl: 'https://checkout.stripe/session' });
  });

  it('marks the org success_url and leaves cancel_url bare', async () => {
    // The {CHECKOUT_SESSION_ID} template must stay literal for Stripe to substitute it;
    // encoded braces would hand the client the placeholder instead of a session id.
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    const args = mockSessionsCreate.mock.calls[0][0] as { success_url: string; cancel_url: string };
    expect(args.success_url).toBe(
      'https://app.example.com/cb?subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}'
    );
    expect(args.success_url).not.toContain('%7B');
    expect(args.cancel_url).toBe(CALLBACK_URL);
  });

  // The #1424 clamp: minSeats = min(max(MIN, members + 1), MAX). Both bounds need a fixture
  // where they actually bite - with the default one-member org the floor coincides with MIN,
  // so asserting `minimum: MIN` passes even if the whole expression is deleted.
  it.each([
    { members: 10, expected: 11, why: 'floor tracks members + 1 once it exceeds MIN' },
    {
      members: 150,
      expected: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
      why: 'ceiling clamps at MAX so minimum can never exceed maximum (#1424 wedge)',
    },
  ])('clamps the adjustable-quantity floor: $why', async ({ members, expected }) => {
    mockOrgFindById.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: Array.from({ length: members }, (_, i) => ({ userId: `user_${i}` })),
    });
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    const args = mockSessionsCreate.mock.calls[0][0] as {
      line_items: { adjustable_quantity: unknown }[];
    };
    expect(args.line_items[0].adjustable_quantity).toEqual({
      enabled: true,
      minimum: expected,
      maximum: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
    });
    expect(res.statusCode).toBe(200);
  });

  it('creates a customer with no org lookup on the new-organization branch', async () => {
    // organizationData instead of organizationId is the shape CreateTeamModal sends, and it
    // was unexercised: no org exists yet, so createCustomer runs unconditionally and the
    // metadata carries newOrganizationName rather than an organizationId.
    const { req, res } = createMocks({ method: 'POST' });
    (req as Record<string, unknown>).body = {
      priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
      organizationData: { name: 'Brand New Org' },
      callbackUrl: CALLBACK_URL,
    };
    (req as Record<string, unknown>).user = { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' };

    await (handler as HandlerFn)(req, res);

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockOrgUpdate).not.toHaveBeenCalled();
    expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
    const args = mockSessionsCreate.mock.calls[0][0] as {
      customer: string;
      subscription_data: { metadata: Record<string, unknown> };
    };
    expect(args.customer).toBe('cus_new');
    expect(args.subscription_data.metadata).toMatchObject({ newOrganizationName: 'Brand New Org' });
    expect(args.subscription_data.metadata).not.toHaveProperty('organizationId');
    expect(res.statusCode).toBe(200);
  });
});

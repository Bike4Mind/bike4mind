// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

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
// rather than only the message.
import { BadRequestError, ForbiddenError, HttpStatus } from '@bike4mind/common';

const mockOrgFindById = vi.fn();
const mockUserFindById = vi.fn();
const mockOrgFindOneAndUpdate = vi.fn();
const mockUserFindOneAndUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
  userRepository: { findById: (...args: unknown[]) => mockUserFindById(...args) },
  Organization: { findOneAndUpdate: (...args: unknown[]) => mockOrgFindOneAndUpdate(...args) },
  User: { findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args) },
}));

const mockFindActiveByOwner = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwner: (...args: unknown[]) => mockFindActiveByOwner(...args),
  },
}));

// Drives the admin-grant branch on the Organization owner path; unreached on the guard tests.
const mockResolveSubscriptionSource = vi.fn();
vi.mock('@server/services/organizationService', () => ({
  resolveSubscriptionSource: (...args: unknown[]) => mockResolveSubscriptionSource(...args),
}));

// Drive the origin verdict per test rather than hard-coding it: a stub pinned to `true` would
// make the rejection path untestable, which is exactly the gap this file closes.
const mockIsAllowedCallbackOrigin = vi.fn();
vi.mock('@server/integrations/stripe/callbackUrl', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/stripe/callbackUrl')>();
  return { ...actual, isAllowedCallbackOrigin: (...args: unknown[]) => mockIsAllowedCallbackOrigin(...args) };
});

const mockPortalSessionsCreate = vi.fn();
const mockCreateCustomer = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  CustomerType: { User: 'User', Organization: 'Organization' },
  stripe: {
    billingPortal: { sessions: { create: (...args: unknown[]) => mockPortalSessionsCreate(...args) } },
  },
}));

import handler from '../portal';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const CALLBACK_URL = 'https://app.example.com/settings/billing';

function makeReq(callbackUrl = CALLBACK_URL, ownerType = 'User', ownerId = 'user_1') {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = { callbackUrl, ownerType, ownerId };
  (req as Record<string, unknown>).user = { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' };
  return { req, res };
}

describe('POST /api/stripe/portal - callbackUrl origin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockUserFindById.mockResolvedValue({ id: 'user_1', email: 'buyer@example.com', stripeCustomerId: 'cus_existing' });
    mockFindActiveByOwner.mockResolvedValue([]);
    mockPortalSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe/session' });
  });

  it('rejects a callbackUrl on a disallowed origin with a 400', async () => {
    // The billing portal's return_url is attacker-reachable the same way checkout's
    // success_url is: Stripe performs the redirect, so an external origin phishes off
    // Stripe's own hosted page.
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('https://attacker.example.net/phish');

    // Asserted in ONE throw: message and status together, so the handler runs once. Invoking
    // it twice would double every mock's call log for the assertions below.
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

    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockFindActiveByOwner).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
  });

  it('passes an allowed-origin callbackUrl through as the portal return_url', async () => {
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith(CALLBACK_URL);
    expect(mockPortalSessionsCreate).toHaveBeenCalledWith({ customer: 'cus_existing', return_url: CALLBACK_URL });
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ url: 'https://billing.stripe/session' });
  });

  it('resolves the organization customer on the Organization owner path', async () => {
    // The owner-type branch was previously unexercised: only the User path was asserted, so a
    // regression that resolved the wrong customer here would not have failed anything.
    mockOrgFindById.mockResolvedValue({
      id: 'org_1',
      userId: 'user_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      stripeCustomerId: 'cus_org',
    });
    const { req, res } = makeReq(CALLBACK_URL, 'Organization', 'org_1');

    await (handler as HandlerFn)(req, res);

    expect(mockOrgFindById).toHaveBeenCalledWith('org_1');
    // 'cus_org', not the User path's 'cus_existing' - that difference is the assertion.
    expect(mockPortalSessionsCreate).toHaveBeenCalledWith({ customer: 'cus_org', return_url: CALLBACK_URL });
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('refuses the portal for an admin-granted organization instead of bootstrapping billing', async () => {
    // An admin-granted org has no Stripe subscription; letting the portal auto-create a customer
    // here would quietly start a billing relationship that only convert-to-paid should begin.
    mockOrgFindById.mockResolvedValue({
      id: 'org_1',
      userId: 'user_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      stripeCustomerId: null,
    });
    mockFindActiveByOwner.mockResolvedValue([{ id: 'sub_1' }]);
    mockResolveSubscriptionSource.mockReturnValue('admin_grant');
    const { req, res } = makeReq(CALLBACK_URL, 'Organization', 'org_1');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: ForbiddenError,
      message: 'Contact support to enable billing for this organization.',
    });

    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
  });
});

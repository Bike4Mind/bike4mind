// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

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
import { BadRequestError, NotFoundError, HttpStatus } from '@bike4mind/common';

// The route reads the org through verifyOrgOwner and, on the org path, writes only through
// attachOrgStripeCustomer - which owns both the Stripe customer creation and the conditional
// persist. So this one mock is the entire durable-side-effect surface of the org branch, and the
// "leaves no trace" assertions below key off it. Its own race semantics are pinned in
// server/integrations/stripe/attachOrgStripeCustomer.test.ts.
// Resist re-adding a findById or organizationRepository stub: a route that reads or writes the
// org outside the gate is the defect this file guards against.
const mockAttachOrgStripeCustomer = vi.fn();
vi.mock('@server/integrations/stripe/attachOrgStripeCustomer', () => ({
  attachOrgStripeCustomer: (...args: unknown[]) => mockAttachOrgStripeCustomer(...args),
}));

// The owner gate. Mocked because the real one imports @bike4mind/database/infra (a different
// specifier than the mock above, so it would reach the real mongoose models); its own owner /
// non-owner / admin / bad-id behaviour is pinned in server/utils/__tests__/orgAccess.test.ts.
// Here it stands in for "the caller owns this org", and its rejection stands in for "they do not".
const mockVerifyOrgOwner = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgOwner: (...args: unknown[]) => mockVerifyOrgOwner(...args),
}));

const mockFindNonTerminalSubscriptionsByOwner = vi.fn();
const mockFindByPriceIdAndOwner = vi.fn(() => {
  throw new Error('the org guard must read non-terminal rows; active-only lets a past_due org double-subscribe');
});
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findNonTerminalSubscriptionsByOwner: (...args: unknown[]) => mockFindNonTerminalSubscriptionsByOwner(...args),
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
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([]); // no live org subscription
    // No stripeCustomerId: the route must therefore reach attachOrgStripeCustomer, which is what
    // makes the "no side effect on rejection" assertions below capable of failing. With a customer
    // id pre-set the route skipped that branch, so those assertions held whether the guard ran or not.
    mockVerifyOrgOwner.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockAttachOrgStripeCustomer.mockResolvedValue('cus_org');
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

    expect(mockFindNonTerminalSubscriptionsByOwner).not.toHaveBeenCalled();
    expect(mockVerifyOrgOwner).not.toHaveBeenCalled();
    expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled(); // the DB write the guard now provably precedes
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('passes an allowed-origin callbackUrl through to the checkout session', async () => {
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith(CALLBACK_URL);
    // The org path creates its Stripe customer inside attachOrgStripeCustomer, never directly - so
    // this positive assertion is also what would catch a regression back to a direct createCustomer.
    expect(mockAttachOrgStripeCustomer).toHaveBeenCalledTimes(1);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    // The session must be opened against the customer the org document actually points at - the
    // helper's return value, not a locally created one.
    expect((mockSessionsCreate.mock.calls[0][0] as { customer: string }).customer).toBe('cus_org');
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
    mockVerifyOrgOwner.mockResolvedValue({
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

    expect(mockVerifyOrgOwner).not.toHaveBeenCalled();
    expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled();
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

/**
 * The guard read active-only, so an org whose subscription was past_due - a row the read route
 * also hid - could start a second checkout while the first kept dunning. This is the part that
 * costs money; the UI assertions elsewhere are downstream of it.
 */
describe('POST /api/organizations/subscriptions/subscribe - duplicate subscription guard', () => {
  const liveRow = (status: string) => ({ priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID, status });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([]);
    mockVerifyOrgOwner.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockAttachOrgStripeCustomer.mockResolvedValue('cus_org');
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  it.each(['past_due', 'unpaid', 'incomplete'] as const)(
    'refuses a second checkout while a %s subscription is live, and creates no session',
    async status => {
      mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([liveRow(status)]);
      const { req, res } = makeReq();

      await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
        constructor: BadRequestError,
        statusCode: HttpStatus.BadRequest,
        message: expect.stringContaining('payment problem'),
      });

      expect(mockSessionsCreate).not.toHaveBeenCalled();
      // The guard sits above the org write, so a refused duplicate leaves no Stripe customer
      // behind: on this branch attachOrgStripeCustomer owns the createCustomer call.
      expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled();
    }
  );

  it('still refuses an active row with the original wording', async () => {
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([liveRow('active')]);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'An active subscription already exists for this organization',
    });

    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  // Deliberate: one live subscription per org, so trialing and paused block a second
  // checkout too - they are non-terminal, so the widened read sees them.
  it.each(['trialing', 'paused'] as const)(
    'refuses a second checkout while a %s subscription is live',
    async status => {
      mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([liveRow(status)]);
      const { req, res } = makeReq();

      await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
        constructor: BadRequestError,
        statusCode: HttpStatus.BadRequest,
      });

      expect(mockSessionsCreate).not.toHaveBeenCalled();
    }
  );

  it('allows a checkout when the only row is terminal, so a lapsed org can resubscribe', async () => {
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([]);
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockFindNonTerminalSubscriptionsByOwner).toHaveBeenCalledWith(SubscriptionOwnerType.Organization, 'org_1');
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});

/**
 * The route took `organizationId` off the request body and never checked the caller's relationship
 * to it. Any authenticated caller could name another tenant's org and have this handler stamp a
 * Stripe customer onto that org's document (a durable cross-tenant write that costs the attacker
 * nothing), read its headcount back off the checkout page's adjustable-quantity floor, and open a
 * session against its subscription. The gate is what closes that, and its POSITION is half the fix:
 * every assertion below is about what must NOT have happened by the time it rejects.
 */
describe('POST /api/organizations/subscriptions/subscribe - organization owner gate', () => {
  // The real gate answers NotFoundError for a non-owner and for a missing org alike, so the route
  // cannot be used to tell the two apart. Reproduced here so the status this route returns to a
  // non-owner is asserted, not assumed.
  const notOwner = () => new NotFoundError('Organization not found');

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([]);
    mockVerifyOrgOwner.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockAttachOrgStripeCustomer.mockResolvedValue('cus_org');
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  it('gates on the caller and the body-supplied org id', async () => {
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    // The pair is the point: gating the wrong org id, or on something other than the
    // authenticated caller, would still satisfy a bare "was it called" assertion.
    expect(mockVerifyOrgOwner).toHaveBeenCalledTimes(1);
    expect(mockVerifyOrgOwner).toHaveBeenCalledWith(req.user, 'org_1');
  });

  it('refuses a caller who does not own the organization', async () => {
    mockVerifyOrgOwner.mockRejectedValue(notOwner());
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      statusCode: HttpStatus.NotFound,
      message: 'Organization not found',
    });
  });

  it('leaves no trace on the target org when the caller is refused', async () => {
    // The zero-cost half of the finding. createCustomer + update are the durable cross-tenant
    // write; findNonTerminalSubscriptionsByOwner is the subscription-status oracle; the checkout
    // session is the headcount disclosure. None may be reachable by a non-owner.
    mockVerifyOrgOwner.mockRejectedValue(notOwner());
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow();

    expect(mockFindNonTerminalSubscriptionsByOwner).not.toHaveBeenCalled();
    expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('reads the org exactly once, through the gate', async () => {
    // Re-reading the org after the gate would be harmless today but is how this class of defect
    // grows back: the second read is the one a later edit forgets to authorize. The org the
    // session is built from must be the one the gate returned - asserted via a member count the
    // default fixture does not produce.
    mockVerifyOrgOwner.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: Array.from({ length: 7 }, (_, i) => ({ userId: `user_${i}` })),
    });
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockVerifyOrgOwner).toHaveBeenCalledTimes(1);
    const args = mockSessionsCreate.mock.calls[0][0] as {
      line_items: { adjustable_quantity: { minimum: number } }[];
    };
    expect(args.line_items[0].adjustable_quantity.minimum).toBe(8);
  });

  it('does not gate the new-organization branch, which has no tenant to authorize against', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    (req as Record<string, unknown>).body = {
      priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
      organizationData: { name: 'Brand New Org' },
      callbackUrl: CALLBACK_URL,
    };
    (req as Record<string, unknown>).user = { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' };

    await (handler as HandlerFn)(req, res);

    expect(mockVerifyOrgOwner).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

/**
 * Branches around the gate that carry money or identity but had no coverage. The canonical-id
 * cases are the ones with teeth: everything downstream of the gate keys off the id on the GATED
 * DOCUMENT, never the raw body string, because `isValidObjectId` accepts uppercase hex while the
 * subscription rows are written from the always-lowercase `org.id`.
 */
describe('POST /api/organizations/subscriptions/subscribe - request-shape and id-canonicalisation branches', () => {
  function makeBody(body: Record<string, unknown>) {
    const { req, res } = createMocks({ method: 'POST' });
    (req as Record<string, unknown>).body = {
      priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
      quantity: ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
      callbackUrl: CALLBACK_URL,
      ...body,
    };
    (req as Record<string, unknown>).user = { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' };
    return { req, res };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockFindNonTerminalSubscriptionsByOwner.mockResolvedValue([]);
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockAttachOrgStripeCustomer.mockResolvedValue('cus_org');
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  // An owner may spell their own org id in uppercase hex: it passes isValidObjectId and findById
  // casts it, so the gate returns the right document. Keying the duplicate guard off the raw
  // string then misses the byte-exact ownerId match and lets a second checkout through - a double
  // charge against one entitlement. Both the guard and the Stripe metadata must use org.id.
  it('uses the gated document id, not the body spelling, for the guard and the metadata', async () => {
    const CANONICAL = '650000000000000000000abc';
    mockVerifyOrgOwner.mockResolvedValue({
      id: CANONICAL,
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    const { req, res } = makeBody({ organizationId: CANONICAL.toUpperCase() });

    await (handler as HandlerFn)(req, res);

    // The gate still receives what the caller sent - it is the thing that resolves it.
    expect(mockVerifyOrgOwner).toHaveBeenCalledWith(req.user, CANONICAL.toUpperCase());
    expect(mockFindNonTerminalSubscriptionsByOwner).toHaveBeenCalledWith(SubscriptionOwnerType.Organization, CANONICAL);
    const args = mockSessionsCreate.mock.calls[0][0] as {
      subscription_data: { metadata: Record<string, unknown> };
    };
    expect(args.subscription_data.metadata.organizationId).toBe(CANONICAL);
    expect(res.statusCode).toBe(200);
  });

  // The refine only asks that the key be present, so "" used to parse, read as falsy, and skip
  // BOTH the gate and the duplicate guard - creating a customer and a checkout session stamped
  // with metadata.organizationId === ''. Rejected at the schema now.
  it('rejects an empty organizationId at the schema, before the gate', async () => {
    const { req, res } = makeBody({ organizationId: '' });

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow();

    expect(mockVerifyOrgOwner).not.toHaveBeenCalled();
    // The one place asserting createCustomer directly still means something: `''` is FALSY, so a
    // regression that let it past the schema would take the new-organization branch and call
    // createCustomer here, not inside attachOrgStripeCustomer. On the org branch this assertion is
    // unreachable by construction, which is why it is not repeated in the tests above.
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  // A malformed id reaches the gate, which answers 400 - the documented status delta from the
  // 404 the CastError remap used to produce. Nothing downstream may run.
  it('propagates the gate 400 for a malformed org id and leaves nothing behind', async () => {
    mockVerifyOrgOwner.mockRejectedValue(new BadRequestError('Invalid organization ID'));
    const { req, res } = makeBody({ organizationId: 'not-an-object-id' });

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Invalid organization ID',
    });

    expect(mockFindNonTerminalSubscriptionsByOwner).not.toHaveBeenCalled();
    expect(mockAttachOrgStripeCustomer).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  // Both fields together parse (the refine wants at least one, not exactly one). The id branch
  // wins for the gate and the customer while the metadata keys off organizationData - so the
  // invoice webhook runs its create-a-new-org path against THIS org's Stripe customer. Pinned as
  // the behaviour that exists, not the behaviour that is wanted; tracked separately as a
  // billing-attribution bug. If a fix lands, this test is the one to change.
  it('gates on the id but still tags the metadata as a new org when both fields are sent', async () => {
    mockVerifyOrgOwner.mockResolvedValue({
      id: 'org_1',
      name: 'Org One',
      billingContact: 'billing@example.com',
      users: [{ userId: 'user_1' }],
    });
    const { req, res } = makeBody({ organizationId: 'org_1', organizationData: { name: 'Brand New Org' } });

    await (handler as HandlerFn)(req, res);

    expect(mockVerifyOrgOwner).toHaveBeenCalledWith(req.user, 'org_1');
    expect(mockAttachOrgStripeCustomer).toHaveBeenCalledTimes(1);
    const args = mockSessionsCreate.mock.calls[0][0] as {
      customer: string;
      subscription_data: { metadata: Record<string, unknown> };
    };
    expect(args.customer).toBe('cus_org');
    expect(args.subscription_data.metadata).toMatchObject({ newOrganizationName: 'Brand New Org' });
    expect(args.subscription_data.metadata).not.toHaveProperty('organizationId');
  });
});

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

// asyncHandler only awaits its argument (it is @deprecated and does not catch), so identity
// preserves the throw this file asserts on.
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

// Deliberately NOT mocking the error classes: the real BadRequestError carries statusCode
// 400, which lets the rejection test assert the status the client would actually receive
// rather than only the message.
import { BadRequestError, NotFoundError, HttpStatus } from '@bike4mind/common';

const mockOrgFindById = vi.fn();
const mockOrgFindOneAndUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
  Organization: { findOneAndUpdate: (...args: unknown[]) => mockOrgFindOneAndUpdate(...args) },
}));

const mockFindActiveByOwner = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwner: (...args: unknown[]) => mockFindActiveByOwner(...args),
  },
}));

// Needed only so importing the handler resolves; the guard rejects long before it is reached.
vi.mock('@server/services/organizationService', () => ({ resolveSubscriptionSource: vi.fn() }));

const mockLogAuditEvent = vi.fn();
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_CONVERT_INITIATED: 'org_convert_initiated' },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// Drive the origin verdict per test rather than hard-coding it: a stub pinned to `true` would
// make the rejection path untestable, which is exactly the gap this file closes.
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
  CustomerType: { Organization: 'Organization' },
  stripe: {
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  },
}));

import handler from '../convert-to-paid';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const CALLBACK_URL = 'https://app.example.com/admin/organizations';

function makeReq(callbackUrl = CALLBACK_URL) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'org_1' } });
  (req as Record<string, unknown>).body = { callbackUrl };
  // The guard sits BELOW the isAdmin check and the id check, so both must be satisfied for
  // the request to reach it at all.
  (req as Record<string, unknown>).user = { id: 'admin_1', username: 'admin', isAdmin: true };
  return { req, res };
}

describe('POST /api/admin/organizations/[id]/convert-to-paid - callbackUrl origin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
  });

  it('rejects a callbackUrl on a disallowed origin with a 400', async () => {
    // Admin-initiated, but the callbackUrl still arrives in the request body - so an admin
    // with a tampered client, or a CSRF-shaped request, could aim Stripe's post-checkout
    // redirect off-origin.
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

  it('runs the guard before any lookup, Stripe side effect, or audit write', async () => {
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('https://attacker.example.net/phish');

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow();

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockFindActiveByOwner).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('lets an allowed origin through to the organization lookup', async () => {
    // Pins the guard as the ONLY reason the rejection tests above stop early: with the same
    // fixtures and an allowed origin, execution reaches organizationRepository.findById.
    // Without this, `not.toHaveBeenCalled()` above could pass for the wrong reason.
    mockOrgFindById.mockResolvedValue(null);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith(CALLBACK_URL);
    expect(mockOrgFindById).toHaveBeenCalledWith('org_1');
  });
});

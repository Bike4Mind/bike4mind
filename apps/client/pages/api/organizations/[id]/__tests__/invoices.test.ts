// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError } from '@bike4mind/common';
import { ORG_INVOICES_LIMIT } from '@client/app/utils/orgInvoices';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
  orgFindById: vi.fn(),
  isStripeConfigured: vi.fn(),
  invoicesList: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: { use: () => unknown; get: (fn: Handler) => unknown } = {
    use: () => chain,
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRefs.rateLimitOptions = options;
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => mockRefs.isStripeConfigured(),
  getStripe: () => ({ invoices: { list: mockRefs.invoicesList } }),
}));

// The gate (verifyOrgOwner) runs for real against a stubbed repository, so these tests pin who the
// route admits rather than asserting a mocked helper.
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockRefs.orgFindById(...args) },
}));
// orgAccess pulls in resolveActiveOrg, which imports the NON-/infra barrel.
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

import { ORG_INVOICES_RATE_LIMIT } from '../invoices';

const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const APPOINTED_ADMIN = '650000000000000000000444';
const MEMBER = '650000000000000000000333';

const org = {
  id: ORG,
  userId: OWNER,
  adminUserIds: [APPOINTED_ADMIN],
  users: [{ userId: MEMBER }],
  stripeCustomerId: 'cus_org',
};

const stripeInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'in_1',
  number: 'ABC-0001',
  created: 1_760_000_000,
  amount_due: 4_900,
  amount_paid: 4_900,
  currency: 'usd',
  status: 'paid',
  hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
  invoice_pdf: 'https://pay.stripe.com/invoice/in_1/pdf',
  ...overrides,
});

const call = async (user: { id: string; isAdmin: boolean }, orgId: string = ORG) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: orgId } });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await mockRefs.getHandler!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRefs.orgFindById.mockResolvedValue(org);
  mockRefs.isStripeConfigured.mockReturnValue(true);
  mockRefs.invoicesList.mockResolvedValue({ data: [stripeInvoice()], has_more: false });
});

describe('GET /api/organizations/[id]/invoices', () => {
  it('is session-only and rate limited', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    expect(mockRefs.rateLimitOptions).toMatchObject({
      bucket: 'org-invoices',
      limit: ORG_INVOICES_RATE_LIMIT,
      windowMs: 60 * 1000,
    });
  });

  it("lists the owner's invoices by the org's Stripe customer", async () => {
    const res = await call({ id: OWNER, isAdmin: false });

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({
      invoices: [
        {
          id: 'in_1',
          number: 'ABC-0001',
          createdAt: new Date(1_760_000_000 * 1000).toISOString(),
          amountDue: 4_900,
          amountPaid: 4_900,
          currency: 'usd',
          status: 'paid',
          hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
          invoicePdf: 'https://pay.stripe.com/invoice/in_1/pdf',
        },
      ],
      hasMore: false,
    });
    expect(mockRefs.invoicesList).toHaveBeenCalledWith(
      { customer: 'cus_org', limit: ORG_INVOICES_LIMIT },
      { timeout: 5_000, maxNetworkRetries: 0 }
    );
  });

  it('leaves out drafts and passes through hasMore', async () => {
    mockRefs.invoicesList.mockResolvedValue({
      data: [stripeInvoice({ id: 'in_draft', status: 'draft' }), stripeInvoice({ id: 'in_open', status: 'open' })],
      has_more: true,
    });

    const body = (await call({ id: OWNER, isAdmin: false }))._getJSONData();

    expect(body.invoices.map((invoice: { id: string }) => invoice.id)).toEqual(['in_open']);
    expect(body.hasMore).toBe(true);
  });

  it('maps missing hosted and PDF links to null', async () => {
    mockRefs.invoicesList.mockResolvedValue({
      data: [stripeInvoice({ hosted_invoice_url: undefined, invoice_pdf: null })],
      has_more: false,
    });

    const [invoice] = (await call({ id: OWNER, isAdmin: false }))._getJSONData().invoices;

    expect(invoice).toMatchObject({ hostedInvoiceUrl: null, invoicePdf: null });
  });

  it.each([
    ['a platform admin', { id: MEMBER, isAdmin: true }],
    ['an appointed admin', { id: APPOINTED_ADMIN, isAdmin: false }],
    ['an ordinary member', { id: MEMBER, isAdmin: false }],
  ])('404s %s without calling Stripe', async (_label, user) => {
    await expect(call(user)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });
    expect(mockRefs.invoicesList).not.toHaveBeenCalled();
  });

  it('404s a missing org identically to a non-owner', async () => {
    mockRefs.orgFindById.mockResolvedValue(null);

    await expect(call({ id: OWNER, isAdmin: false })).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });
  });

  it('400s a malformed org id without touching the database', async () => {
    await expect(call({ id: OWNER, isAdmin: false }, 'not-an-object-id')).rejects.toMatchObject({
      constructor: BadRequestError,
    });
    expect(mockRefs.orgFindById).not.toHaveBeenCalled();
  });

  it('answers an empty list when the org has no Stripe customer', async () => {
    mockRefs.orgFindById.mockResolvedValue({ ...org, stripeCustomerId: null });

    const res = await call({ id: OWNER, isAdmin: false });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ invoices: [], hasMore: false });
    expect(mockRefs.invoicesList).not.toHaveBeenCalled();
  });

  it('answers an empty list when Stripe is not configured', async () => {
    mockRefs.isStripeConfigured.mockReturnValue(false);

    const res = await call({ id: OWNER, isAdmin: false });

    expect(res._getJSONData()).toEqual({ invoices: [], hasMore: false });
    expect(mockRefs.invoicesList).not.toHaveBeenCalled();
  });

  it('answers 502 when Stripe fails', async () => {
    mockRefs.invoicesList.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }));

    const res = await call({ id: OWNER, isAdmin: false });

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ message: 'Stripe request failed' });
  });

  it('rethrows a non-Stripe failure', async () => {
    mockRefs.invoicesList.mockRejectedValue(new Error('boom'));

    await expect(call({ id: OWNER, isAdmin: false })).rejects.toThrow('boom');
  });
});

import type Stripe from 'stripe';
import { NotFoundError } from '@bike4mind/utils';
import { getStripe, isStripeConfigured } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { verifyOrgOwner } from '@bike4mind/server-utils/utils/orgAccess';
import { ORG_INVOICES_LIMIT, type OrgInvoice, type OrgInvoicesResponse } from '@client/app/utils/orgInvoices';
import { baseApi } from '@server/middlewares/baseApi';

export const ORG_INVOICES_RATE_LIMIT = 30;
const ONE_MINUTE_MS = 60 * 1000;
// One Stripe call; a timeout surfaces as a StripeConnectionError and answers 502 below.
const STRIPE_READ_OPTIONS: Stripe.RequestOptions = { timeout: 5_000, maxNetworkRetries: 0 };

const isStripeError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && String((error as { type?: unknown }).type).startsWith('Stripe');

const toOrgInvoice = (invoice: Stripe.Invoice): OrgInvoice => ({
  id: invoice.id,
  number: invoice.number,
  createdAt: new Date(invoice.created * 1000).toISOString(),
  amountDue: invoice.amount_due,
  amountPaid: invoice.amount_paid,
  currency: invoice.currency,
  status: invoice.status ?? 'open',
  hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  invoicePdf: invoice.invoice_pdf ?? null,
});

const EMPTY: OrgInvoicesResponse = { invoices: [], hasMore: false };

/**
 * GET /api/organizations/:id/invoices - the org's most recent Stripe invoices for its Billing tab.
 * Owner only, like the tab (orgTabAccess `canViewOrgBilling`) and the billing portal route: platform
 * admins get 404 here too and use the admin subscription page instead. An org with no Stripe customer
 * has no invoices. First-party only (`jwtOnly`), so it needs no public API contract.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: ORG_INVOICES_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'org-invoices' }))
  .get(async (req, res) => {
    const organizationId = typeof req.query.id === 'string' ? req.query.id : '';
    const org = await verifyOrgOwner(req.user!, organizationId);
    // verifyOrgOwner admits platform admins; this list is the owner's alone.
    if (org.userId !== req.user!.id) throw new NotFoundError('Organization not found');

    res.setHeader('Cache-Control', 'private, no-store');
    if (!org.stripeCustomerId || !isStripeConfigured()) return res.status(200).json(EMPTY);

    try {
      const page = await getStripe().invoices.list(
        { customer: org.stripeCustomerId, limit: ORG_INVOICES_LIMIT },
        STRIPE_READ_OPTIONS
      );
      const body: OrgInvoicesResponse = {
        // Drafts are not final and have no hosted page yet.
        invoices: page.data.filter(invoice => invoice.status !== 'draft').map(toOrgInvoice),
        hasMore: page.has_more,
      };
      return res.status(200).json(body);
    } catch (error) {
      if (!isStripeError(error)) throw error;
      req.logger?.error('Org invoice list failed at Stripe', error);
      return res.status(502).json({ message: 'Stripe request failed' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

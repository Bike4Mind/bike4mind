/** One invoice in the org Billing tab, mapped from Stripe by `pages/api/organizations/[id]/invoices.ts`. */
export type OrgInvoice = {
  id: string;
  number: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** Minor units of `currency`, as Stripe sends them. */
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: 'open' | 'paid' | 'uncollectible' | 'void' | (string & {});
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

export type OrgInvoicesResponse = {
  invoices: OrgInvoice[];
  /** More invoices exist at Stripe than the list returns; the billing portal shows them all. */
  hasMore: boolean;
};

export const ORG_INVOICES_LIMIT = 24;

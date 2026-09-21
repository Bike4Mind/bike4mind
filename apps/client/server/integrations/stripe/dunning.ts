import { stripe } from '@server/integrations/stripe/stripe';

export interface VoidOpenInvoicesResult {
  /** Invoice ids that were voided. */
  voided: string[];
  /** Invoice ids whose void call failed; already logged as a set by the caller. */
  failed: string[];
}

export interface VoidOpenInvoicesOptions {
  /**
   * Unix seconds, Stripe's own unit for timestamps. When set, only invoices
   * created strictly before this instant are voided.
   */
  createdBefore?: number | null;
}

/**
 * Void the open invoices on a subscription, optionally only those that already
 * existed at a given moment.
 *
 * An open invoice is what keeps Stripe's dunning schedule (and its "payment
 * unsuccessful" email) running after a customer cancels, so every place that
 * records a cancel calls this to close what is left open.
 *
 * `createdBefore` is for callers observing a *scheduled* period-end cancel: that
 * event fires again on every later update, and the subscriber can legitimately
 * spend during the window, so a fresh proration invoice must not be swept up with
 * the stale dunning one.
 *
 * A single invoice lost to a race must not abandon the rest, so per-invoice
 * failures are collected in `failed` and the loop continues. A failure to LIST
 * the invoices still throws - the caller has a try/catch around the whole call
 * and is the only place that can log it, and returning an empty result would
 * hide a real cleanup failure.
 *
 * Bounded to one page on purpose: a subscription with more than 100
 * simultaneously open invoices is not a real case, and an unbounded paging loop
 * over a money-affecting write is worse than the theoretical miss.
 */
export async function voidOpenSubscriptionInvoices(
  subscriptionId: string,
  options: VoidOpenInvoicesOptions = {}
): Promise<VoidOpenInvoicesResult> {
  const open = await stripe.invoices.list({
    subscription: subscriptionId,
    status: 'open',
    limit: 100,
    ...(options.createdBefore ? { created: { lt: options.createdBefore } } : {}),
  });

  const voided: string[] = [];
  const failed: string[] = [];

  for (const invoice of open.data) {
    try {
      await stripe.invoices.voidInvoice(invoice.id);
      voided.push(invoice.id);
    } catch {
      failed.push(invoice.id);
    }
  }

  return { voided, failed };
}

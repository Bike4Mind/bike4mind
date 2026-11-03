import type Stripe from 'stripe';
import { stripe } from './stripe';

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
  /** Per Stripe request timeout (ms); the client default applies when unset. */
  timeoutMs?: number;
  /**
   * Epoch ms. Each Stripe request's timeout is capped to the time left, and once it passes the
   * invoices not yet voided are reported in `failed` without a call.
   */
  deadline?: number;
  /** Per Stripe request retry cap; the client default applies when unset. */
  maxNetworkRetries?: number;
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
  const params: Stripe.InvoiceListParams = {
    subscription: subscriptionId,
    status: 'open',
    limit: 100,
    ...(options.createdBefore ? { created: { lt: options.createdBefore } } : {}),
  };
  const requestOptionsNow = () => {
    const timeout =
      options.deadline === undefined
        ? options.timeoutMs
        : Math.max(1, Math.min(options.timeoutMs ?? Infinity, options.deadline - Date.now()));
    return timeout || options.maxNetworkRetries !== undefined
      ? {
          ...(timeout ? { timeout } : {}),
          ...(options.maxNetworkRetries !== undefined ? { maxNetworkRetries: options.maxNetworkRetries } : {}),
        }
      : undefined;
  };
  const listOptions = requestOptionsNow();
  const open = await (listOptions ? stripe.invoices.list(params, listOptions) : stripe.invoices.list(params));

  const voided: string[] = [];
  const failed: string[] = [];

  for (const invoice of open.data) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      failed.push(invoice.id);
      continue;
    }
    try {
      const requestOptions = requestOptionsNow();
      await (requestOptions
        ? stripe.invoices.voidInvoice(invoice.id, undefined, requestOptions)
        : stripe.invoices.voidInvoice(invoice.id));
      voided.push(invoice.id);
    } catch {
      failed.push(invoice.id);
    }
  }

  return { voided, failed };
}

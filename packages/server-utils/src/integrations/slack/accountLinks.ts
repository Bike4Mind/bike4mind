import { classifyStage, escapeSlackText, toAbsoluteUrl } from '@bike4mind/common';

/**
 * A user's internal ID plus a link to their admin page; the bare ID when APP_URL is unset. Same
 * output as adminOwnerSlackRef (subscriptionLifecycle.ts) for a user, without its model imports.
 */
export function adminUserSlackRef(userId: string, appUrl: string | null = process.env.APP_URL?.trim() || null): string {
  const id = `\`${escapeSlackText(userId)}\``;
  if (!appUrl) return id;
  return `${id} - <${escapeSlackText(toAbsoluteUrl(appUrl, `/admin/users/${encodeURIComponent(userId)}`))}|Open in admin>`;
}

/** A customer's Stripe dashboard link; non-production stages bill through test mode, under /test. */
export function stripeCustomerSlackLink(stripeCustomerId: string | null | undefined, stage: string): string {
  if (!stripeCustomerId) return 'no Stripe customer';
  const modePrefix = classifyStage(stage) === 'production' ? '' : '/test';
  const url = `https://dashboard.stripe.com${modePrefix}/customers/${encodeURIComponent(stripeCustomerId)}`;
  return `<${escapeSlackText(url)}|Stripe>`;
}

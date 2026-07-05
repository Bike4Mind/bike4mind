/**
 * Restrict Stripe callback URLs (success_url / cancel_url / billing portal
 * return_url) to the deployed app's own origin. Stripe lands the customer on a
 * hosted page - letting an attacker (or a confused admin) point them at an
 * external domain is an open-redirect / phishing vector through Stripe's brand.
 *
 * Fail-closed semantics: if APP_URL is not configured in a production-shaped
 * environment we reject rather than waving everything through. The dev-only
 * pass-through guards against the obvious misconfiguration (typo, secret
 * rotation gone bad, new stage missing the var) silently disabling the check.
 */
export function isAllowedCallbackOrigin(url: string): boolean {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    if (process.env.NODE_ENV === 'production') return false;
    return true; // dev convenience; APP_URL is set in all deployed stages
  }
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

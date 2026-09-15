// Acquisition-attribution cookies, shared by the conversion trackers
// (signupConversion, purchaseConversion) so every conversion event stamps the
// same fields read the same way.
//
// Both are first-party JSON cookies on the parent domain:
// - `b4m-first-touch`: written once by the marketing site on the visitor's
//   first-ever landing (90-day, write-once) and shared across subdomains. The
//   producing side of this contract lives in the marketing-site repo.
// - `b4m_utm`: this app's own landing-UTM capture (30-min TTL - see
//   utmCapture.ts), i.e. the campaign that drove *this* session.

export const FIRST_TOUCH_COOKIE = 'b4m-first-touch';
export const UTM_COOKIE = 'b4m_utm';

/** Parse a JSON cookie; null when absent, malformed, or not an object. */
export function readJsonCookie(name: string): Record<string, unknown> | null {
  const entry = document.cookie.split('; ').find(c => c.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(entry.slice(name.length + 1)));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read a non-empty string field, or undefined - so callers can skip empty params. */
export function stringField(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The attribution params to stamp onto a conversion event.
 *
 * `sessionUtmSuffix` names the moment for the session-UTM params (`signup` ->
 * `utm_source_at_signup`), so one funnel can distinguish the campaign that drove
 * the signup from the one that drove the purchase. First-touch params are
 * moment-independent: there is only ever one first touch.
 */
export function attributionParams(sessionUtmSuffix: string): Record<string, string> {
  const firstTouch = readJsonCookie(FIRST_TOUCH_COOKIE);
  const utm = readJsonCookie(UTM_COOKIE);

  const params: Record<string, string> = {};
  const stamp = (param: string, value: string | undefined) => {
    if (value) params[param] = value;
  };
  stamp('first_touch_source', stringField(firstTouch, 'source'));
  stamp('first_touch_medium', stringField(firstTouch, 'medium'));
  stamp('first_touch_campaign', stringField(firstTouch, 'campaign'));
  stamp(`utm_source_at_${sessionUtmSuffix}`, stringField(utm, 'source'));
  stamp(`utm_medium_at_${sessionUtmSuffix}`, stringField(utm, 'medium'));
  stamp(`utm_campaign_at_${sessionUtmSuffix}`, stringField(utm, 'campaign'));
  return params;
}

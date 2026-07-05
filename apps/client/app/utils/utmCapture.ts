const UTM_COOKIE_NAME = 'b4m_utm';
// 30-minute window: long enough for a landing session, short enough to not persist stale campaigns.
const TTL_SECONDS = 30 * 60;

/**
 * Capture utm_* params from the current URL into a first-party cookie that the server-side
 * analytics emitter reads on the first authenticated request of the day.
 *
 * MUST run at app bootstrap (before the router resolves routes), NOT in a React effect: an
 * unauthenticated landing on `/?utm_source=...` is redirected to `/login` by the route guard,
 * which strips the query string before any component effect runs. Capturing synchronously at
 * module load - while `window.location.search` still holds the landing URL - is what makes the
 * common acquisition path (logged-out user arriving from a campaign) actually attributable.
 *
 * Only writes when `utm_source` is present (deliberate campaign attribution intent). Safe during
 * SSR (no-ops without `window`) and safe to call more than once (idempotent for a given URL).
 */
export function captureUtmParams(): void {
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams(window.location.search);
  const source = params.get('utm_source');
  if (!source) return;

  const utm: Record<string, string> = { source };
  const medium = params.get('utm_medium');
  if (medium) utm.medium = medium;
  const campaign = params.get('utm_campaign');
  if (campaign) utm.campaign = campaign;
  const content = params.get('utm_content');
  if (content) utm.content = content;

  const expires = new Date(Date.now() + TTL_SECONDS * 1000).toUTCString();
  document.cookie = `${UTM_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(utm))}; path=/; SameSite=Strict; expires=${expires}`;
}

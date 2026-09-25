const UTM_COOKIE_NAME = 'b4m_utm';
// 30-minute window: long enough for a landing session, short enough to not persist stale campaigns.
const TTL_SECONDS = 30 * 60;

// Purchase attribution needs a longer memory than a session. A visitor who lands from a campaign
// and subscribes a week later has lost `b4m_utm` by checkout, so the same capture also keeps:
// - the last campaign landing, overwritten on each one, for 30 days
// - the first campaign landing this app saw, written once, for 90 days - a fallback for the
//   marketing site's parent-domain `b4m-first-touch`, which only visitors who came through the
//   marketing site carry. It has its own name so the two can never be confused or overwrite
//   each other; the server prefers the marketing site's when both exist.
// Both are read server-side at checkout (server/analytics/acquisition.ts).
export const LAST_TOUCH_COOKIE_NAME = 'b4m_last_touch';
export const APP_FIRST_TOUCH_COOKIE_NAME = 'b4m_app_first_touch';
const LAST_TOUCH_TTL_SECONDS = 30 * 24 * 60 * 60;
const APP_FIRST_TOUCH_TTL_SECONDS = 90 * 24 * 60 * 60;

function hasCookie(name: string): boolean {
  return document.cookie.split('; ').some(c => c.startsWith(`${name}=`));
}

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

  const value = encodeURIComponent(JSON.stringify(utm));
  const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toUTCString();
  document.cookie = `${UTM_COOKIE_NAME}=${value}; path=/; SameSite=Strict; expires=${expiresIn(TTL_SECONDS)}`;
  document.cookie = `${LAST_TOUCH_COOKIE_NAME}=${value}; path=/; SameSite=Strict; expires=${expiresIn(LAST_TOUCH_TTL_SECONDS)}`;
  if (!hasCookie(APP_FIRST_TOUCH_COOKIE_NAME)) {
    document.cookie = `${APP_FIRST_TOUCH_COOKIE_NAME}=${value}; path=/; SameSite=Strict; expires=${expiresIn(APP_FIRST_TOUCH_TTL_SECONDS)}`;
  }
}

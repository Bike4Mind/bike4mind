// Consent region, resolved by the marketing site rather than here.
//
// The marketing site and this app are two hosts on one visitor journey, and a
// journey must not ask for consent halfway through. A visitor auto-allowed on
// the way in who then meets a banner here has every conversion they generate
// floored by that second ask - and downstream that reads as a bad funnel
// rather than an unmeasured one, which is the more expensive mistake because
// it looks like an answer.
//
// The marketing site's middleware resolves the region once, at the only edge
// on the journey that sees the visitor's country, and pins the answer to the
// parent domain. This app has no middleware and no country header of its own,
// so it reads that answer instead of computing a second one that could
// disagree. Same shared-cookie mechanism as attributionCookies.ts; the
// producing side lives in the marketing-site repo.
//
// A deployment with no such upstream - any fork, or this app reached directly
// - never sees the cookie and keeps the universal banner, which is the safe
// default rather than a degraded one.

export const REGION_COOKIE = 'b4m-region';

/** 'eu' means opt-in required before anything non-essential loads. */
export type ConsentRegion = 'eu' | 'row';

/**
 * The visitor's coarse consent region.
 *
 * Anything other than an explicit 'row' - cookie absent, unreadable, or an
 * unrecognized value - resolves to 'eu'. The fail-safe direction is asking
 * someone who did not have to be asked; guessing the other way would drop
 * trackers on a visitor entitled to refuse them first.
 */
export function readConsentRegion(): ConsentRegion {
  if (typeof document === 'undefined') return 'eu';
  const entry = document.cookie.split('; ').find(c => c.startsWith(`${REGION_COOKIE}=`));
  return entry?.slice(REGION_COOKIE.length + 1) === 'row' ? 'row' : 'eu';
}

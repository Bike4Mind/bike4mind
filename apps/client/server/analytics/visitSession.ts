import crypto from 'crypto';
import { parseCookies } from './cookies';

/**
 * A visit, expressed as a first-party cookie.
 *
 * The analytics emitter needs a session identifier whose distinct count is a count of
 * visits. It cannot derive one: a request carries a user (sometimes) and a day (always),
 * and both of those are stable across many visits. So the server mints one value per
 * visit, hands it to the browser, and reads it back.
 *
 * What "a visit" then means, precisely: a browser holding this cookie, ending after
 * VISIT_TTL_SECONDS with no request that refreshes it. Two consequences worth knowing
 * before treating the count as a session count:
 *
 *   - Two tabs of the same browser are one visit, because the cookie is per-browser.
 *   - A single page kept open for hours without a reload stops refreshing the cookie, so
 *     the next load after the window lapses is a second visit. That is the same rule a
 *     30-minute inactivity window gives everywhere else it is used; it is not a defect
 *     to be fixed by lengthening the window, which would instead merge genuinely separate
 *     visits.
 *
 * The 30 minutes deliberately match the utm cookie's own window (utmCapture.ts), so a
 * visit and the campaign attributed to it expire together rather than a visit outliving
 * the attribution that explains it.
 */

export const VISIT_COOKIE = 'b4m_vid';

export const VISIT_TTL_SECONDS = 30 * 60;

/**
 * 16 random bytes, hex. Two properties matter and neither is cryptographic: it is wide
 * enough that two concurrent visits will not collide into one, and it is a fixed shape,
 * which is what makes the read below able to reject anything else.
 */
export function mintVisitId(): string {
  return crypto.randomBytes(16).toString('hex');
}

const VISIT_ID_SHAPE = /^[0-9a-f]{32}$/;

/**
 * The visit id this request carries, or undefined when it carries none we minted.
 *
 * The shape check is not decoration. This value is stored on every event and grouped on
 * downstream, and the cookie is client-controlled: without the check, anyone can write
 * their own visit ids - a 200-character string per request, or the same constant for
 * everyone - and the funnel's first stage becomes whatever a visitor decided it should
 * be. Rejecting an unrecognised value (and re-minting) costs one extra counted visit for
 * that browser and keeps the stored set to values this server issued.
 */
export function readVisitId(cookieHeader: string | undefined): string | undefined {
  const value = parseCookies(cookieHeader)[VISIT_COOKIE];
  return value !== undefined && VISIT_ID_SHAPE.test(value) ? value : undefined;
}

/**
 * Set-Cookie value for a visit id. Sent on every beacon request, not only when minting:
 * re-sending it is what slides the inactivity window forward, so an active browser keeps
 * one visit instead of accumulating one per 30 minutes.
 *
 * HttpOnly because no client code reads it. SameSite=Lax rather than Strict so a visitor
 * arriving by a top-level link from a campaign, an email or a search result still presents
 * the cookie on that first navigation - under Strict they would not, and every referred
 * arrival would start a second visit the moment it made an in-app request.
 */
export function visitCookieHeader(visitId: string, opts: { secure: boolean }): string {
  const attrs = [`${VISIT_COOKIE}=${visitId}`, 'Path=/', `Max-Age=${VISIT_TTL_SECONDS}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Agents that run a browser engine and would otherwise be counted as visits. Crawlers that
// do not execute JavaScript never reach the beacon at all, which is most of them; what is
// left is the headless-browser tail - uptime checks, link previews, Lighthouse runs, our own
// smoke tests - plus request tools that someone points at the endpoint by hand.
const NON_HUMAN_AGENT =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python-requests|okhttp|axios|node-fetch|insomnia|postman/i;

/**
 * Best effort, and worth being explicit about which way it errs: a user-agent blocklist
 * removes the agents that announce themselves and nothing else. An agent that presents a
 * real browser string and keeps no cookies is counted as a new visit on every request -
 * the beacon only emits when it sees no cookie - so the per-IP rate limit on the route,
 * not this list, is what bounds that case. A request with no user-agent at all is treated
 * as non-human: browsers always send one.
 */
export function isProbableBot(userAgent: string | undefined): boolean {
  if (!userAgent || userAgent.trim() === '') return true;
  return NON_HUMAN_AGENT.test(userAgent);
}

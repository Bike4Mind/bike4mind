import type { Request } from 'express';
import type { OverwatchUtm } from '@bike4mind/common';

/**
 * First-party cookies the analytics emitter reads.
 *
 * Both of the readers here are shared by two call sites - the per-request middleware
 * and the visit beacon - and a cookie parsed differently in those two places is a
 * cookie that silently means two things. The parser is deliberately lenient (a
 * malformed pair is skipped, not fatal) because a cookie jar is client-controlled
 * input: the worst outcome of a bad pair is one missing attribution, and the worst
 * outcome of throwing is a 500 on a page load.
 */

// Named on both sides of the wire: the client writer is app/utils/utmCapture.ts and the
// client reader is app/utils/attributionCookies.ts, which declares its own constant for the
// same name. A rename has to touch both - there is no shared module a server file and a
// browser file can both import without one layer reaching into the other.
export const UTM_COOKIE = 'b4m_utm';

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    try {
      result[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      // malformed percent-encoding - skip pair
    }
  }
  return result;
}

/**
 * The campaign that drove this browser's current landing, as captured client-side by
 * utmCapture.ts into a 30-minute cookie. Every field is length-capped here as well as
 * there: the cookie is client-controlled, and these values are stored and grouped on.
 */
export function readUtmCookie(req: Request): OverwatchUtm | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[UTM_COOKIE];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const utm: OverwatchUtm = {};
    if (typeof parsed.source === 'string') utm.source = parsed.source.substring(0, 128);
    if (typeof parsed.medium === 'string') utm.medium = parsed.medium.substring(0, 128);
    if (typeof parsed.campaign === 'string') utm.campaign = parsed.campaign.substring(0, 128);
    if (typeof parsed.content === 'string') utm.content = parsed.content.substring(0, 128);
    return Object.keys(utm).length > 0 ? utm : undefined;
  } catch {
    return undefined;
  }
}

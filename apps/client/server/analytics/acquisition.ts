import crypto from 'crypto';
import type { Request } from 'express';
import type { OverwatchUtm } from '@bike4mind/common';
import type { SubscriptionAcquisition, SubscriptionAcquisitionTouch } from '@client/lib/subscriptions/types';
import { UTM_COOKIE, parseCookies } from './cookies';

/**
 * Where a paying customer came from: the campaign on their first landing and on their last one
 * before checkout. Read from first-party cookies at checkout, carried through Stripe as
 * subscription metadata (the only thing that survives to the webhook), and stored on the
 * subscription row when the first invoice is paid.
 */
export interface AcquisitionTouches {
  firstTouch?: OverwatchUtm;
  lastTouch?: OverwatchUtm;
}

// The marketing site's parent-domain first-touch cookie (see app/utils/attributionCookies.ts),
// then this app's own fallbacks written by app/utils/utmCapture.ts.
const MARKETING_FIRST_TOUCH_COOKIE = 'b4m-first-touch';
const APP_FIRST_TOUCH_COOKIE = 'b4m_app_first_touch';
const LAST_TOUCH_COOKIE = 'b4m_last_touch';

const UTM_FIELDS = ['source', 'medium', 'campaign', 'content'] as const;
// Client-controlled input that ends up in Stripe metadata (values cap at 500) and in grouped
// analytics; the same cap as readUtmCookie.
const MAX_FIELD = 128;

function readUtmJson(raw: string | undefined): OverwatchUtm | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const utm: OverwatchUtm = {};
    for (const f of UTM_FIELDS) {
      const v = parsed[f];
      if (typeof v === 'string' && v.trim()) utm[f] = v.trim().substring(0, MAX_FIELD);
    }
    return utm.source ? utm : undefined;
  } catch {
    return undefined;
  }
}

/** The touches this browser carries. A touch without a `source` is no touch. */
export function readAcquisitionTouches(req: Pick<Request, 'headers'>): AcquisitionTouches {
  const cookies = parseCookies(req.headers.cookie);
  const firstTouch = readUtmJson(cookies[MARKETING_FIRST_TOUCH_COOKIE]) ?? readUtmJson(cookies[APP_FIRST_TOUCH_COOKIE]);
  const lastTouch = readUtmJson(cookies[LAST_TOUCH_COOKIE]) ?? readUtmJson(cookies[UTM_COOKIE]);
  return { ...(firstTouch && { firstTouch }), ...(lastTouch && { lastTouch }) };
}

// Flat keys, because Stripe metadata is a flat string map (keys cap at 40 characters).
const PREFIX = { firstTouch: 'acq_first_', lastTouch: 'acq_last_' } as const;

export function acquisitionToStripeMetadata(touches: AcquisitionTouches): Record<string, string> {
  const out: Record<string, string> = {};
  for (const touch of ['firstTouch', 'lastTouch'] as const) {
    const utm = touches[touch];
    if (!utm) continue;
    for (const f of UTM_FIELDS) if (utm[f]) out[`${PREFIX[touch]}${f}`] = utm[f]!;
  }
  return out;
}

/**
 * The inverse, from a Stripe subscription's metadata, in the shape the subscription row stores.
 * Undefined when neither touch was recorded.
 */
export function acquisitionFromStripeMetadata(
  metadata: Record<string, string | undefined> | null | undefined
): SubscriptionAcquisition | undefined {
  if (!metadata) return undefined;
  const out: SubscriptionAcquisition = {};
  for (const touch of ['firstTouch', 'lastTouch'] as const) {
    const read = (f: (typeof UTM_FIELDS)[number]) => {
      const v = metadata[`${PREFIX[touch]}${f}`];
      return typeof v === 'string' && v ? v.substring(0, MAX_FIELD) : undefined;
    };
    const source = read('source');
    if (!source) continue;
    const t: SubscriptionAcquisitionTouch = { source };
    for (const f of ['medium', 'campaign', 'content'] as const) {
      const v = read(f);
      if (v) t[f] = v;
    }
    out[touch] = t;
  }
  return out.firstTouch || out.lastTouch ? out : undefined;
}

/**
 * A UUID that is the same every time for the same parts, so a retried webhook sends the same
 * eventId and the receiver keeps one event. Formatted as a version-4-shaped UUID, which is what
 * the ingest schema accepts.
 */
export function stableEventId(...parts: string[]): string {
  const h = crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

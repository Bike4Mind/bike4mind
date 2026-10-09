import type { Request } from 'express';
import type { SubscriptionAcquisition, SubscriptionAcquisitionTouch } from '@client/lib/subscriptions/types';
import {
  ACQUISITION_FIELD_LIMIT,
  readAcquisitionCookies,
  type AcquisitionTouches,
} from '@client/lib/subscriptions/acquisition';
import { parseCookies } from './cookies';
import { resolveServerConsent } from './serverConsent';

const UTM_FIELDS = ['source', 'medium', 'campaign', 'content'] as const;

/** The touches this browser carries. A touch without a `source` is no touch. */
export function readAcquisitionTouches(req: Pick<Request, 'headers'>): AcquisitionTouches {
  const cookies = parseCookies(req.headers.cookie);
  return readAcquisitionCookies(name => cookies[name]);
}

/**
 * The touches this browser carries, or nothing at all unless consent was granted.
 *
 * The gate belongs here rather than at each call site: the raw reader above cannot tell whether
 * its caller is checkout (which carries its own `attributionConsent` flag from the client) or a
 * path with no flag to carry. Anything that emits attribution off a bare request should use this,
 * not the reader above. That is a convention, not an enforcement - `readAcquisitionTouches` stays
 * exported for checkout, which gates on its own flag, so a new call site CAN still reach past this
 * one. Making it unreachable would take splitting the ungated reader into a module checkout alone
 * imports.
 *
 * Note the parent-domain `b4m-first-touch` is exactly why this matters: `clearAttributionCookies`
 * deliberately leaves it in place on a decline, and `readAcquisitionCookies` prefers it over the
 * app's own first-touch cookie, so a declining visitor still carries a readable touch.
 */
export function readConsentedAcquisitionTouches(req: Pick<Request, 'headers'>): AcquisitionTouches {
  if (resolveServerConsent(req) !== 'granted') return {};
  return readAcquisitionTouches(req);
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
      return typeof v === 'string' && v ? v.substring(0, ACQUISITION_FIELD_LIMIT) : undefined;
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

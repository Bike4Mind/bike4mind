import type { Request } from 'express';
import type { SubscriptionAcquisition, SubscriptionAcquisitionTouch } from '@client/lib/subscriptions/types';
import { ACQUISITION_FIELD_LIMIT, readAcquisitionCookies } from '@client/lib/subscriptions/acquisition';
import type { AcquisitionTouches } from '@client/lib/subscriptions/acquisition';
import { parseCookies } from './cookies';

const UTM_FIELDS = ['source', 'medium', 'campaign', 'content'] as const;

/** The touches this browser carries. A touch without a `source` is no touch. */
export function readAcquisitionTouches(req: Pick<Request, 'headers'>): AcquisitionTouches {
  const cookies = parseCookies(req.headers.cookie);
  return readAcquisitionCookies(name => cookies[name]);
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

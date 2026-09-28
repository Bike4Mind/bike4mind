import type { OverwatchUtm } from '@bike4mind/common';
import type { AcquisitionTouches } from './acquisition';
import { stableEventId } from './acquisition';
import { emitProductEvent, HOST_PRODUCT_ID, ingestKeyFor } from './emitActiveEvent';

// Kept apart from acquisition.ts, which is pure: this is the one piece that sends, so importing
// the touch helpers (checkout, the subscription write path) does not pull in the emitter and its
// config.

/**
 * How much these events are worth trusting, carried on every one of them. The product an event is
 * credited to comes from `utm.source` in a first-party cookie, which is to say from the browser:
 * nothing here, and nothing at the ingest end, checks it against where the visitor actually came
 * from. Anyone can put `?utm_source=<some product>` on a link they share, and a real subscription
 * that follows credits that product. So this is what the visitor claimed, not what we observed,
 * and it is the first place in the emitter where a client-supplied string picks WHOSE record gets
 * written - every other emit sends to a productId its caller fixed.
 *
 * Marked rather than trusted silently, so a consumer reading another product's subscribe counts
 * can tell what kind of number it is and filter if it needs to. Verifying the claim would take a
 * signal the server observed for itself (a referrer correlated at landing, signed so it cannot be
 * forged); until one exists, this label is the honest description of the data.
 */
const ATTRIBUTION = 'self-reported';

/**
 * Tell each product the customer came through that they subscribed: one `subscribe` event per
 * distinct touch source that names an Overwatch product this deployment holds a key for, marked
 * with which touch it was. A source that is only a campaign channel (an email, a social network)
 * has no key and sends nothing. The host product is not sent here: its funnel counts new
 * subscribers from its own daily totals, and a second path would double it.
 *
 * Every event carries `attribution: 'self-reported'` - see ATTRIBUTION above for why that matters
 * before these counts are trusted.
 *
 * Awaited by the caller but never throws; emitProductEvent fails open and times out on its own.
 */
export async function emitSubscribeForSourceProducts(opts: {
  userId: string;
  /** The Stripe subscription id: the occurrence, so a retry maps to the same eventId. */
  subscriptionId: string;
  touches: AcquisitionTouches | undefined;
  priceId?: string;
}): Promise<string[]> {
  const byProduct = new Map<string, { touch: 'first' | 'last' | 'both'; utm: OverwatchUtm }>();
  const note = (touch: 'first' | 'last', utm: OverwatchUtm | undefined) => {
    const productId = utm?.source;
    if (!utm || !productId || productId === HOST_PRODUCT_ID || !ingestKeyFor(productId)) return;
    const seen = byProduct.get(productId);
    byProduct.set(productId, seen ? { ...seen, touch: 'both' } : { touch, utm });
  };
  note('first', opts.touches?.firstTouch);
  note('last', opts.touches?.lastTouch);
  await Promise.all(
    [...byProduct.entries()].map(([productId, { touch, utm }]) =>
      emitProductEvent({
        productId,
        event: 'subscribe',
        eventId: stableEventId('subscribe', productId, opts.subscriptionId),
        userId: opts.userId,
        utm,
        metadata: { touch, attribution: ATTRIBUTION, ...(opts.priceId ? { priceId: opts.priceId } : {}) },
      }).catch(() => {})
    )
  );
  return [...byProduct.keys()];
}

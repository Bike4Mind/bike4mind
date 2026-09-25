import type { OverwatchUtm } from '@bike4mind/common';
import type { AcquisitionTouches } from './acquisition';
import { stableEventId } from './acquisition';
import { emitProductEvent, HOST_PRODUCT_ID, ingestKeyFor } from './emitActiveEvent';

// Kept apart from acquisition.ts, which is pure: this is the one piece that sends, so importing
// the touch helpers (checkout, the subscription write path) does not pull in the emitter and its
// config.

/**
 * Tell each product the customer came through that they subscribed: one `subscribe` event per
 * distinct touch source that names an Overwatch product this deployment holds a key for, marked
 * with which touch it was. A source that is only a campaign channel (an email, a social network)
 * has no key and sends nothing. The host product is not sent here: its funnel counts new
 * subscribers from its own daily totals, and a second path would double it.
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
        metadata: { touch, ...(opts.priceId ? { priceId: opts.priceId } : {}) },
      }).catch(() => {})
    )
  );
  return [...byProduct.keys()];
}

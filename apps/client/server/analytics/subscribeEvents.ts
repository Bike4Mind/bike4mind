import type { OverwatchUtm } from '@bike4mind/common';
import type { AcquisitionTouches } from './acquisition';
import { stableEventId } from './acquisition';
import { emitProductEvent, HOST_PRODUCT_ID, ingestKeyFor } from './emitActiveEvent';

// Kept apart from acquisition.ts, which is pure: this is the one piece that sends, so importing
// the touch helpers (checkout, the subscription write path) does not pull in the emitter and its
// config. It sends the two conversions another product can be credited with: `signup` when an
// account is created, and `subscribe` when its first invoice is paid.

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

type SourceTouch = { touch: 'first' | 'last' | 'both'; utm: OverwatchUtm };

/**
 * The products a conversion is credited to: each distinct touch source that names an Overwatch
 * product this deployment holds a key for, with which touch it was. A source that is only a
 * campaign channel (an email, a social network) has no key and is no product. The host product is
 * never one: its funnel counts its own signups and subscribers, and a second path would double it.
 */
function sourceProducts(touches: AcquisitionTouches | undefined): Map<string, SourceTouch> {
  const byProduct = new Map<string, SourceTouch>();
  const note = (touch: 'first' | 'last', utm: OverwatchUtm | undefined) => {
    const productId = utm?.source;
    if (!utm || !productId || productId === HOST_PRODUCT_ID || !ingestKeyFor(productId)) return;
    const seen = byProduct.get(productId);
    byProduct.set(productId, seen ? { ...seen, touch: 'both' } : { touch, utm });
  };
  note('first', touches?.firstTouch);
  note('last', touches?.lastTouch);
  return byProduct;
}

/**
 * Send `event` to each source product (see sourceProducts), marked with its touch and with
 * `attribution: 'self-reported'` - see ATTRIBUTION above for why that matters before these counts
 * are trusted. `occurrence` makes the eventId, so a retry of the same conversion sends the same id
 * and the receiver keeps one event. Never throws; emitProductEvent fails open and times out on its
 * own.
 *
 * Resolves to the products it ATTEMPTED, not the ones that succeeded: each emit swallows its own
 * rejection, so a product whose post failed is still in this list. Do not treat the return value
 * as delivery - nothing here observes the outcome.
 */
async function emitForSourceProducts(opts: {
  event: 'signup' | 'subscribe';
  occurrence: string;
  userId: string;
  touches: AcquisitionTouches | undefined;
  metadata?: Record<string, string>;
}): Promise<string[]> {
  const byProduct = sourceProducts(opts.touches);
  await Promise.all(
    [...byProduct.entries()].map(([productId, { touch, utm }]) =>
      emitProductEvent({
        productId,
        event: opts.event,
        eventId: stableEventId(opts.event, productId, opts.occurrence),
        userId: opts.userId,
        utm,
        metadata: { touch, attribution: ATTRIBUTION, ...opts.metadata },
      }).catch(() => {})
    )
  );
  return [...byProduct.keys()];
}

/**
 * Tell each product the customer came through that they subscribed. Never throws.
 *
 * GROUNDWORK, NOT LIVE: nothing calls this. The invoice-webhook call site was removed in
 * 31f12201b when #3362 deferred cookie-routed subscribe events, and this PR does not restore it -
 * only the signup path below is wired. `invoicePaymentSucceeded.test.ts` still asserts that the
 * webhook emits nothing, and that assertion passes. Kept so the two conversions stay one shape
 * for whenever the subscribe decision is settled; delete it, and the `signup | subscribe`
 * parameterization with it, if that decision lands the other way.
 */
export function emitSubscribeForSourceProducts(opts: {
  userId: string;
  /** The Stripe subscription id: the occurrence, so a retry maps to the same eventId. */
  subscriptionId: string;
  touches: AcquisitionTouches | undefined;
  priceId?: string;
}): Promise<string[]> {
  return emitForSourceProducts({
    event: 'subscribe',
    occurrence: opts.subscriptionId,
    userId: opts.userId,
    touches: opts.touches,
    metadata: opts.priceId ? { priceId: opts.priceId } : undefined,
  });
}

/**
 * Tell each product a new user came through that they signed up: the middle stage of that
 * product's funnel, between its visits and its subscribers. Called once, where an account is
 * created with the new user's own request in hand (their cookies carry the touches). The user id
 * is the occurrence, since an account signs up once. Awaited by the caller but never throws, and
 * resolves at once when no touch names a product, which is most signups.
 */
export function emitSignupForSourceProducts(opts: {
  userId: string;
  touches: AcquisitionTouches | undefined;
  /** How the account was created (`otc`, `google`, `github`, ...), for splitting the stage. */
  method: string;
}): Promise<string[]> {
  return emitForSourceProducts({
    event: 'signup',
    occurrence: opts.userId,
    userId: opts.userId,
    touches: opts.touches,
    metadata: { method: opts.method },
  });
}

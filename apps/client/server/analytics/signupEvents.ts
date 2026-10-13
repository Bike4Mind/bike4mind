import crypto from 'crypto';
import type { OverwatchUtm } from '@bike4mind/common';
import type { AcquisitionTouches } from '@client/lib/subscriptions/acquisition';
import { emitProductEvent, HOST_PRODUCT_ID, ingestKeyFor } from './emitActiveEvent';
import { pseudonymizeUserId } from './pseudonymize';

// Kept apart from acquisition.ts, which is pure: this is the one piece that sends, so importing
// the touch helpers (checkout, the subscription write path) does not pull in the emitter and its
// config. It sends the conversions another product can be credited with: `signup`, when an account
// is created, and `purchase`, when that account later pays (an individual subscription invoice or
// a credit pack). Both pick the credited product from a self-reported `utm.source` and say so on
// the event (see ATTRIBUTION). docs-site/docs/security/telemetry-data-classification.md describes
// both streams and must stay in sync with what this module sends.

/**
 * A UUID that is the same every time for the same parts, so a retried request sends the same
 * eventId and the receiver keeps one event. Formatted as a version-4-shaped UUID, which is what
 * the ingest schema accepts. Lives here, with its only caller, rather than in the pure cookie
 * readers next door, which have no need of crypto.
 */
export function stableEventId(...parts: string[]): string {
  const h = crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * How much these events are worth trusting, carried on every one of them. The product an event is
 * credited to comes from `utm.source` in a first-party cookie, which is to say from the browser:
 * nothing here, and nothing at the ingest end, checks it against where the visitor actually came
 * from. Anyone can put `?utm_source=<some product>` on a link they share, and a real signup that
 * follows credits that product. So this is what the visitor claimed, not what we observed,
 * and it is the first place in the emitter where a client-supplied string picks WHOSE record gets
 * written - every other emit sends to a productId its caller fixed.
 *
 * Marked rather than trusted silently, so a consumer reading another product's signup counts
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
 * Tell each product a new user came through that they signed up: the middle stage of that
 * product's funnel, between its visits and its subscribers. Sends to each source product (see
 * sourceProducts), marked with its touch and with `attribution: 'self-reported'` - see ATTRIBUTION
 * for why that matters before these counts are trusted.
 *
 * Called once, where an account is created with the new user's own request in hand (their cookies
 * carry the touches). The user's pseudonym makes the eventId, since an account signs up once, so a
 * retry sends the same id and the receiver keeps one event. Awaited by the caller but never throws
 * (emitProductEvent fails open and times out on its own), and resolves at once when no touch names
 * a product, which is most signups.
 *
 * Resolves to the products it ATTEMPTED, not the ones that succeeded: each emit swallows its own
 * rejection, so a product whose post failed is still in this list. Do not treat the return value
 * as delivery - nothing here observes the outcome.
 */
export async function emitSignupForSourceProducts(opts: {
  userId: string;
  touches: AcquisitionTouches | undefined;
  /** How the account was created (`otc`, `google`, `github`, ...), for splitting the stage. */
  method: string;
}): Promise<string[]> {
  const byProduct = sourceProducts(opts.touches);
  // The eventId is sent verbatim to the credited product, so it is keyed on the salted pseudonym
  // that product already receives as userId, never the raw id: an unsalted hash of an ObjectId
  // (timestamp + 5 random bytes) is brute-forceable back to the host's user id.
  const pseudonym = pseudonymizeUserId(opts.userId);
  await Promise.all(
    [...byProduct.entries()].map(([productId, { touch, utm }]) =>
      emitProductEvent({
        productId,
        event: 'signup',
        eventId: stableEventId('signup', productId, pseudonym),
        userId: opts.userId,
        utm,
        metadata: { touch, attribution: ATTRIBUTION, method: opts.method },
      }).catch(() => {})
    )
  );
  return [...byProduct.keys()];
}

/**
 * The event name for a paid purchase. Not `subscribe`: Overwatch counts `subscribe` as a signup
 * (its signup stage matches `signup` and `subscribe`), so every renewal would show up as a new
 * signup. `purchase` is GA4's name for collected money and what the client-side pixel sends.
 */
export const PURCHASE_EVENT = 'purchase';

export type PurchaseKind = 'subscription' | 'credits';

/** The payer as stored: the touches recorded at signup and the synthetic flag. */
export type PurchaseCreditUser = {
  id: string;
  isSynthetic?: boolean | null;
  acquisition?: AcquisitionTouches | null;
};

/**
 * Tell each product a paying user came through that they paid. Same crediting rule and the same
 * `attribution: 'self-reported'` marker as the signup emit above, so a product's purchases line up
 * with its signups. Overwatch's funnel has no purchase stage yet (its stages are visits, signups
 * and snapshot-based new subscribers), so these land as raw events only.
 *
 * The touches come from the user record (`user.acquisition`, written with consent at signup), not
 * from cookies or from checkout metadata: a purchase is confirmed by a Stripe webhook that has no
 * browser, a credit-pack payment intent carries no attribution metadata at all, and reading the
 * signup touches keeps the purchase on the same product its signup was credited to. Organization
 * invoices are excluded by the caller: their checkout user's signup is not the organization's
 * acquisition. A user with no stored acquisition (they declined consent, or signed up before
 * touches were stored) credits nothing. A later consent withdrawal does not stop it: the webhook
 * has no browser to ask, and the server keeps no per-user consent state, so stored touches keep
 * crediting purchases.
 *
 * Only money actually collected counts: a zero amount (a trial, a fully discounted or
 * balance-paid invoice) sends nothing, and refunds are never sent. Synthetic users are skipped.
 * The eventId is keyed on the Stripe id of the payment (invoice or payment intent) and the product,
 * so a redelivered webhook sends the same id and the receiver keeps one event.
 *
 * `value` is in the currency's major unit (29.99, not 2999), the GA4 convention the client pixel
 * also follows; checkout bills two-decimal currencies only (USD), so dividing by 100 is exact.
 *
 * Awaited by its callers but never throws and never rejects: a webhook must not fail, or be
 * retried, over analytics. Resolves to the products it ATTEMPTED, like the signup emit.
 */
export async function emitPurchaseForSourceProducts(opts: {
  user: PurchaseCreditUser | null | undefined;
  /** The Stripe invoice id or payment intent id the money was collected on. */
  paymentId: string;
  kind: PurchaseKind;
  /** The amount collected, in minor units (cents). */
  amountMinor: number | null | undefined;
  currency: string | null | undefined;
  /** Stripe's billing_reason for an invoice: `subscription_create`, `subscription_cycle`, ... */
  billingReason?: string | null;
}): Promise<string[]> {
  try {
    const { user, paymentId, kind, amountMinor, currency, billingReason } = opts;
    if (!user?.id || user.isSynthetic || !paymentId || !currency) return [];
    if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor) || amountMinor <= 0) return [];
    const byProduct = sourceProducts(user.acquisition ?? undefined);
    await Promise.all(
      [...byProduct.entries()].map(([productId, { touch, utm }]) =>
        emitProductEvent({
          productId,
          event: PURCHASE_EVENT,
          eventId: stableEventId(PURCHASE_EVENT, productId, paymentId),
          reportFailure: true,
          userId: user.id,
          utm,
          metadata: {
            touch,
            attribution: ATTRIBUTION,
            kind,
            value: amountMinor / 100,
            currency: currency.toUpperCase(),
            ...(billingReason && { billingReason }),
          },
        }).catch(() => {
          console.warn('[b4m-analytics] purchase emit failed', { productId });
        })
      )
    );
    return [...byProduct.keys()];
  } catch {
    console.warn('[b4m-analytics] purchase attribution failed');
    return [];
  }
}

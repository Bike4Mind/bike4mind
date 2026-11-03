import type { Request } from 'express';
import { z } from 'zod';
import {
  OVERWATCH_ANALYTICS_SCHEMA_VERSION,
  OVERWATCH_ANONYMOUS_USER_ID,
  OVERWATCH_LANE_VALUES,
  OVERWATCH_UNKNOWN_SESSION_ID,
  type IUserVerifiedTouch,
  type OverwatchAnalyticsEvent,
} from '@bike4mind/common';
import { analyticsHopRepository, type IAnalyticsHopDoc } from '@bike4mind/database';
import { emitProductEvent, HOST_PRODUCT_ID } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { HOP_COOKIE, HOP_EVENT, HOP_MINTED_EVENT, HOP_PARAM } from '@bike4mind/server-utils/lib/hopNames';
import { parseCookies } from '@bike4mind/server-utils/analytics/cookies';
import { resolveServerConsent } from '@bike4mind/server-utils/analytics/serverConsent';
import {
  HOP_TOKEN_TTL_SECONDS,
  hopKey,
  isHopId,
  MAX_HOP_TOKEN_LENGTH,
  mintHopId,
  signHopToken,
  verifyHopToken,
} from './hopToken';
import { stableEventId } from './signupEvents';
import { readVisitId } from './visitSession';

/**
 * Verified hops: a click that left a source product for this app, proven by the source rather than
 * claimed by the browser.
 *
 * 1. The source's server mints a hop with its own ingest key (POST /api/overwatch/v1/hops). The
 *    source product is the key's, so no link can name another product as its source.
 * 2. The source redirects the browser straight to this app with the token in `b4m_hop`.
 * 3. The app takes the token off the URL at bootstrap and sends it with the visit beacon, which
 *    redeems it here once (pages/api/analytics/visit.ts).
 *
 * Mint and redeem send `hop_minted` and `hop` to Overwatch. Unlike the campaign touches (the
 * self-reported stream in signupEvents.ts), nothing here takes a product from the browser.
 */

export { HOP_EVENT, HOP_MINTED_EVENT };

/**
 * Products a hop may be minted to: the ones that can redeem one. Only this app, for now. A hop to
 * anywhere else would be stored and counted as minted but could never be redeemed.
 */
export const HOP_DESTINATIONS = [HOST_PRODUCT_ID] as const;

/**
 * How long a hop record is kept unless something pins it: 90 days, the same window Overwatch keeps
 * its raw events, so minted, redeemed and signed-up counts can be checked against the records they
 * came from. A hop a signup is bound to is evidence a payment may later cite, so it is kept for as
 * long as that can happen (see the signup binding).
 */
export const HOP_RECORD_RETENTION_DAYS = 90;

/** How long a redeemed hop's id is held in the browser for the signup it may lead to. */
export const HOP_COOKIE_TTL_SECONDS = 24 * 60 * 60;

/** The longest destination path accepted at mint. */
const MAX_HOP_PATH = 200;

/** A path on this app: starts with one `/`, no query, fragment, backslash or scheme. */
const HOP_PATH = /^\/(?!\/)[\w\-./~%]*$/;

export const HopMintBodySchema = z
  .object({
    dest: z.enum(HOP_DESTINATIONS),
    path: z.string().max(MAX_HOP_PATH).regex(HOP_PATH, 'path must be a path on the destination').optional(),
    // The source's own session id. Sent only when the source may link it to this click.
    srcSessionId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/, 'srcSessionId must be printable ASCII')
      .optional(),
    // A hash, never a raw identifier: an address or a user name does not fit this shape.
    srcVisitorHash: z
      .string()
      .regex(/^[A-Za-z0-9+/=_-]{16,128}$/, 'srcVisitorHash must be a hash')
      .optional(),
    lane: z.enum(OVERWATCH_LANE_VALUES).optional(),
  })
  // Strict, so a body naming a source (`src`, `srcProductId`, `productId`) is refused rather than
  // silently ignored: the source is always the key's product.
  .strict();

export type HopMintBody = z.infer<typeof HopMintBodySchema>;

export interface MintedHop {
  hop: IAnalyticsHopDoc;
  token: string;
  expiresAt: Date;
  /** Where the source should redirect: the destination path with the token. Absent without APP_URL. */
  url?: string;
}

/** `<APP_URL><path>?b4m_hop=<token>`, or undefined when this deployment names no app URL. */
export function hopLandingUrl(
  path: string | undefined,
  token: string,
  appUrl = process.env.APP_URL
): string | undefined {
  if (!appUrl) return undefined;
  try {
    const url = new URL(path ?? '/', appUrl);
    url.searchParams.set(HOP_PARAM, token);
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Store a hop for `srcProductId` (the minting key's product) and sign its token. Null when this
 * deployment has no hop key, before anything is stored. Throws when the store fails.
 */
export async function mintHop(
  input: HopMintBody & { srcProductId: string },
  now: Date = new Date()
): Promise<MintedHop | null> {
  const key = hopKey();
  if (!key) return null;
  const hopId = mintHopId();
  const exp = Math.floor(now.getTime() / 1000) + HOP_TOKEN_TTL_SECONDS;
  const hop = await analyticsHopRepository.create({
    hopId,
    srcProductId: input.srcProductId,
    dest: input.dest,
    ...(input.path !== undefined && { path: input.path }),
    ...(input.srcSessionId !== undefined && { srcSessionId: input.srcSessionId }),
    ...(input.srcVisitorHash !== undefined && { srcVisitorHash: input.srcVisitorHash }),
    ...(input.lane !== undefined && { lane: input.lane }),
    createdAt: now,
    expiresAt: new Date(now.getTime() + HOP_RECORD_RETENTION_DAYS * 86_400_000),
  });
  const token = signHopToken(key, { hopId, exp, dest: input.dest });
  const url = hopLandingUrl(input.path, token);
  return { hop, token, expiresAt: new Date(exp * 1000), ...(url !== undefined && { url }) };
}

/**
 * The `hop_minted` event, under the SOURCE product. It goes onto the ingest queue the way the
 * source's own events do (pages/api/overwatch/v1/events.ts), since this deployment holds no key of
 * the source's to post it with. Anonymous: the source's session id is its sessionId when the
 * source sent one.
 */
export function hopMintedEvent(hop: IAnalyticsHopDoc): OverwatchAnalyticsEvent {
  return {
    eventId: stableEventId(HOP_MINTED_EVENT, hop.srcProductId, hop.hopId),
    schemaVersion: OVERWATCH_ANALYTICS_SCHEMA_VERSION,
    productId: hop.srcProductId,
    userId: OVERWATCH_ANONYMOUS_USER_ID,
    sessionId: hop.srcSessionId ?? OVERWATCH_UNKNOWN_SESSION_ID,
    event: HOP_MINTED_EVENT,
    timestamp: new Date(hop.createdAt).toISOString(),
    metadata: { hopId: hop.hopId, dest: hop.dest, ...(hop.lane && { lane: hop.lane }) },
  };
}

/** The hop token in a visit beacon's body, or undefined. Never logged. */
export function readHopToken(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { hop } = body as Record<string, unknown>;
  return typeof hop === 'string' && hop.length > 0 && hop.length <= MAX_HOP_TOKEN_LENGTH ? hop : undefined;
}

export type HopRedeemOutcome =
  | { redeemed: true; hop: IAnalyticsHopDoc }
  | { redeemed: false; reason: 'not_configured' | 'malformed' | 'bad_signature' | 'expired' | 'refused' | 'error' };

/**
 * Redeem a hop token on this app, once, and send `hop` to Overwatch under this app's product.
 *
 * The token must carry a valid MAC for this app as the destination and be unexpired; then the
 * stored hop must be this app's, minted within the token lifetime and not yet redeemed, all in one
 * conditional update. Anything else sends nothing: a failed redeem is never a `hop`.
 *
 * `visitId` is linked to the hop only when `linkVisit` (the visitor's consent): it is recorded on
 * the hop and sent as the event's sessionId, and the caller sets the cookie. Without consent the
 * hop is still redeemed and counted, with no visit: in aggregate only, and no identity edge.
 *
 * Never throws: a store failure is `error`, so the visit beacon it runs in still records the visit.
 */
export async function redeemHop(opts: {
  token: string;
  visitId: string;
  linkVisit: boolean;
  now?: Date;
}): Promise<HopRedeemOutcome> {
  const key = hopKey();
  if (!key) return { redeemed: false, reason: 'not_configured' };
  const now = opts.now ?? new Date();
  const check = verifyHopToken(key, opts.token, {
    dest: HOST_PRODUCT_ID,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  if (!check.ok) return { redeemed: false, reason: check.reason };

  let hop: IAnalyticsHopDoc | null;
  try {
    hop = await analyticsHopRepository.redeem({
      hopId: check.hopId,
      dest: HOST_PRODUCT_ID,
      now,
      mintedSince: new Date(now.getTime() - HOP_TOKEN_TTL_SECONDS * 1000),
      ...(opts.linkVisit && { sessionId: opts.visitId }),
    });
  } catch (err) {
    console.warn('[b4m-analytics] hop redeem failed', err instanceof Error ? err.message : err);
    return { redeemed: false, reason: 'error' };
  }
  if (!hop) return { redeemed: false, reason: 'refused' };

  await emitProductEvent({
    productId: HOST_PRODUCT_ID,
    event: HOP_EVENT,
    eventId: stableEventId(HOP_EVENT, HOST_PRODUCT_ID, hop.hopId),
    ...(opts.linkVisit && { sessionId: opts.visitId }),
    metadata: {
      hopId: hop.hopId,
      src: hop.srcProductId,
      dest: hop.dest,
      verified: true,
      ...(hop.lane && { lane: hop.lane }),
    },
    // Once per hop, so a lost one is not recovered by a later request: count a failed delivery.
    reportFailure: true,
  }).catch(() => {});
  return { redeemed: true, hop };
}

/**
 * Set-Cookie value for a redeemed hop's id. HttpOnly because no client code reads it: the signup
 * request is what does. SameSite=Lax, like the visit cookie, so it still arrives on the top-level
 * GET an OAuth provider returns the browser with.
 */
export function hopCookieHeader(hopId: string, opts: { secure: boolean }): string {
  const attrs = [`${HOP_COOKIE}=${hopId}`, 'Path=/', `Max-Age=${HOP_COOKIE_TTL_SECONDS}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** The hop id this request's cookie carries, or undefined when it carries none we set. */
export function readHopCookie(cookieHeader: string | undefined): string | undefined {
  const value = parseCookies(cookieHeader)[HOP_COOKIE];
  return isHopId(value) ? value : undefined;
}

/**
 * The verified touch for a new account: the hop this browser redeemed in this same visit, bound to
 * this signup and to no other. Undefined for a signup that followed no hop, which is most of them.
 *
 * "Same session" is concrete. The signup request must carry:
 *   - the `b4m_hop` cookie naming the hop (set when it was redeemed, with consent; 24 hours);
 *   - the `b4m_vid` visit id the hop was redeemed in (visitSession.ts: one visit ends after 30
 *     minutes without a page load), so a hop from yesterday's visit does not bind today's signup;
 *   - a granted consent decision, the gate the campaign touches use (resolveServerConsent), so a
 *     visitor who withdrew consent after landing is not linked;
 * and the hop must have been redeemed no more than 24 hours ago and never bound before. The bind
 * is one conditional update (analyticsHopRepository.bindToSignup), so one hop credits at most one
 * account even when a browser signs up twice. Never throws.
 */
export async function bindSignupHop(
  req: Pick<Request, 'headers'>,
  now: Date = new Date()
): Promise<IUserVerifiedTouch | undefined> {
  const hopId = readHopCookie(req.headers.cookie);
  const visitId = readVisitId(req.headers.cookie);
  if (hopId === undefined || visitId === undefined || resolveServerConsent(req) !== 'granted') return undefined;
  try {
    const hop = await analyticsHopRepository.bindToSignup({
      hopId,
      dest: HOST_PRODUCT_ID,
      sessionId: visitId,
      now,
      redeemedSince: new Date(now.getTime() - HOP_COOKIE_TTL_SECONDS * 1000),
    });
    if (!hop?.redeemedAt) return undefined;
    return { srcProductId: hop.srcProductId, hopId: hop.hopId, redeemedAt: new Date(hop.redeemedAt) };
  } catch (err) {
    console.warn('[b4m-analytics] signup hop not bound', err instanceof Error ? err.message : err);
    return undefined;
  }
}

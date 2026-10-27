import crypto from 'crypto';
import {
  OVERWATCH_ANALYTICS_SCHEMA_VERSION,
  OVERWATCH_ANONYMOUS_USER_ID,
  OVERWATCH_UNKNOWN_SESSION_ID,
  OVERWATCH_VISIT_EVENT,
} from '@bike4mind/common';
import type { OverwatchUtm } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { laneMetadata } from './lane';
import { pseudonymizeUserId } from '@bike4mind/server-utils/analytics/pseudonymize';

const NOT_CONFIGURED = 'not-configured';
const EMIT_TIMEOUT_MS = 2_000;

/**
 * Counted once per failed emit that asked for `reportFailure` (the billing events). A warning only
 * reaches someone already reading the logs; infra/alarms.ts alarms on this count, so an ingest
 * outage or a bad key does not drop billing events unnoticed. The namespace, name and Stage
 * dimension must match that alarm exactly.
 */
export const INGEST_FAILURE_METRIC = { namespace: 'Lumina5/Analytics', name: 'IngestEmitFailed' } as const;

/** The product this app reports as. Its key is OVERWATCH_INGEST_KEY. */
export const HOST_PRODUCT_ID = 'bike4mind';

function isSet(value: string | undefined): value is string {
  return !!value && value !== NOT_CONFIGURED;
}

/**
 * Other products served from this deployment (premium overlays) each post under their own
 * Overwatch product, and the ingest endpoint only accepts a key's own productId. Their keys live in
 * one JSON secret, OVERWATCH_PRODUCT_INGEST_KEYS: `{"<productId>": "<ingest key>"}`, so adding a
 * product is a secret change, not an infra change. Malformed JSON or a non-string value reads as
 * "no key", and that product's events are dropped - telemetry never throws.
 */
function productIngestKeys(): Record<string, string> {
  const raw = Config.OVERWATCH_PRODUCT_INGEST_KEYS;
  if (!isSet(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && isSet(e[1])
      )
    );
  } catch {
    return {};
  }
}

/** The ingest key for a product, or undefined when it has none. For callers that post other Overwatch writes (such as a daily stats snapshot) with the same key. */
export function ingestKeyFor(productId: string): string | undefined {
  if (productId === HOST_PRODUCT_ID)
    return isSet(Config.OVERWATCH_INGEST_KEY) ? Config.OVERWATCH_INGEST_KEY : undefined;
  const keys = productIngestKeys();
  return Object.hasOwn(keys, productId) ? keys[productId] : undefined;
}

export function isAnalyticsConfigured(productId: string = HOST_PRODUCT_ID): boolean {
  return (
    Config.B4M_ANALYTICS_ENABLED?.toLowerCase() !== 'false' &&
    isSet(Config.OVERWATCH_INGEST_URL) &&
    isSet(Config.OVERWATCH_PSEUDONYM_SALT) &&
    !!ingestKeyFor(productId)
  );
}

// Strip query string and fragment - never forward URL params from the Referer header.
export function sanitizeReferrer(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const cleaned = `${url.protocol}//${url.host}${url.pathname}`;
    return cleaned;
  } catch {
    return undefined;
  }
}

export interface EmitOptions {
  // Pre-pseudonymized userId (caller computes via pseudonymizeUserId for the throttle key,
  // then passes it here to avoid computing HMAC twice).
  pseudoUserId: string;
  sessionId: string;
  userType: 'subscriber' | 'free';
  /** A test persona or test-domain account: its event is stamped with the synthetic lane (lane.ts). */
  isSynthetic?: boolean;
  referrer?: string;
  utm?: OverwatchUtm;
}

export interface VisitEmitOptions {
  /** The visit's own identifier - see visitSession.ts for what one visit means. */
  sessionId: string;
  referrer?: string;
  utm?: OverwatchUtm;
}

/**
 * One event per active user per day: the signal DAU is counted from. A synthetic user's is marked
 * with the synthetic lane rather than dropped, so persona activity can be told apart from real
 * activity instead of being counted as one.
 */
export async function emitActiveEvent(opts: EmitOptions): Promise<void> {
  return postEvent({
    userId: opts.pseudoUserId,
    sessionId: opts.sessionId,
    event: 'active',
    ...(opts.referrer !== undefined && { referrer: opts.referrer }),
    ...(opts.utm !== undefined && { utm: opts.utm }),
    metadata: { userType: opts.userType, ...laneMetadata(opts) },
  });
}

/**
 * One event per visit, carrying no user identity at all.
 *
 * Deliberately anonymous even when the visitor is signed in. A visit count needs an
 * identifier per visit, not a person per visit, and the person is already reported by
 * emitActiveEvent above; sending one here would mean a signed-in visit and an anonymous
 * visit were stored as different kinds of record, and the funnel's first stage would go
 * back to counting two different things. It also means the acquisition stage carries the
 * least data that can answer it: an id this server minted, a referrer, and the campaign
 * cookie - no user, no user type.
 */
export async function emitVisitEvent(opts: VisitEmitOptions): Promise<void> {
  return postEvent({
    userId: OVERWATCH_ANONYMOUS_USER_ID,
    sessionId: opts.sessionId,
    event: OVERWATCH_VISIT_EVENT,
    ...(opts.referrer !== undefined && { referrer: opts.referrer }),
    ...(opts.utm !== undefined && { utm: opts.utm }),
  });
}

export interface ProductEventOptions {
  /** The Overwatch product the event is counted under. Needs a key in OVERWATCH_PRODUCT_INGEST_KEYS. */
  productId: string;
  event: string;
  /**
   * The raw user id. Pseudonymized here with the same salt as every other emit, so the raw id never
   * leaves this module and one person is one user across products. Omit for an anonymous event.
   */
  userId?: string;
  /** The visit id (see visitSession.ts). Omitted means there was no visit to name. */
  sessionId?: string;
  userType?: 'subscriber' | 'free';
  referrer?: string;
  utm?: OverwatchUtm;
  /** Flat and small: the ingest schema caps metadata at 1KB. */
  metadata?: Record<string, string | number | boolean>;
  /**
   * A caller-chosen UUID for an event that may be sent more than once for one occurrence (a
   * retried webhook). The receiver de-duplicates on eventId. Random when omitted.
   */
  eventId?: string;
  /** Log failed delivery for events that need an observable best-effort attempt. */
  reportFailure?: boolean;
}

/**
 * One event under any product this deployment serves. Fire-and-forget like the emits above: no-op
 * when that product has no key, never throws, and bounded by the same 2s timeout, plus one metric
 * write when a `reportFailure` emit fails.
 */
export async function emitProductEvent(opts: ProductEventOptions): Promise<void> {
  if (!isAnalyticsConfigured(opts.productId)) return;
  const metadata = { ...opts.metadata, ...(opts.userType !== undefined && { userType: opts.userType }) };
  return postEvent(
    {
      userId: opts.userId ? pseudonymizeUserId(opts.userId) : OVERWATCH_ANONYMOUS_USER_ID,
      sessionId: opts.sessionId ?? OVERWATCH_UNKNOWN_SESSION_ID,
      event: opts.event,
      ...(opts.referrer !== undefined && { referrer: opts.referrer }),
      ...(opts.utm !== undefined && { utm: opts.utm }),
      ...(Object.keys(metadata).length > 0 && { metadata }),
    },
    opts.productId,
    opts.eventId,
    opts.reportFailure
  );
}

interface EventFields {
  userId: string;
  sessionId: string;
  event: string;
  referrer?: string;
  utm?: OverwatchUtm;
  metadata?: Record<string, string | number | boolean>;
}

async function postEvent(
  fields: EventFields,
  productId: string = HOST_PRODUCT_ID,
  eventId: string = crypto.randomUUID(),
  reportFailure = false
): Promise<void> {
  if (!isAnalyticsConfigured(productId)) return;

  const timestamp = new Date().toISOString();

  const event = {
    eventId,
    schemaVersion: OVERWATCH_ANALYTICS_SCHEMA_VERSION,
    productId,
    timestamp,
    ...fields,
  };

  const url = Config.OVERWATCH_INGEST_URL;
  const key = ingestKeyFor(productId);
  // isAnalyticsConfigured() above already checked both are set; narrows the type here.
  if (!url || !key) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMIT_TIMEOUT_MS);
  let failed = false;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // x-api-key per apiKeyAuth.ts - NOT Bearer (Bearer falls through to JWT auth -> 401)
        'x-api-key': key,
      },
      body: JSON.stringify({ event }),
      signal: ac.signal,
      // Do not follow 30x redirects: unlike Authorization (auto-stripped on cross-origin redirects
      // per the Fetch spec), x-api-key is a custom header that Node/undici does NOT auto-strip -
      // refusing to follow redirects is the only thing preventing key replay to another host.
      redirect: 'manual',
    });
    failed = res.type === 'opaqueredirect' || res.status >= 300;

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      // redirect: 'manual' surfaces a 3xx as an opaque-redirect response (status 0), which never
      // reaches the receiver and is almost always a misconfigured OVERWATCH_INGEST_URL (scheme,
      // host, or trailing-slash redirect). Log it so the misconfig is diagnosable instead of every
      // emit silently dropping. Status only, never the key or body.
      console.warn('[b4m-analytics] ingest URL returned a redirect — check OVERWATCH_INGEST_URL', {
        status: res.status,
        productId,
      });
    } else if (res.status >= 400 && res.status < 500) {
      // Permanent client error - log status only, never the key or body
      console.warn('[b4m-analytics] permanent ingest error', { status: res.status, productId });
    } else if (reportFailure && res.status >= 500) {
      console.warn('[b4m-analytics] ingest server error', { status: res.status, productId });
    }
    // 503 / 5xx -> drop, with a warning only when the caller requested one. Note:
    // OverwatchUserDay's (productId, date, userId) upsert is
    // CROSS-INSTANCE dedup, not a retry - it suppresses duplicates once some emit has succeeded,
    // but it does not recover a user-day where every attempt failed. A user who touches only one
    // Lambda instance that day and whose single emit fails is simply absent from DAU for that day.
    // Acceptable for best-effort telemetry; high-traffic users self-heal across instances.
  } catch {
    failed = true;
    if (reportFailure) {
      console.warn('[b4m-analytics] ingest request failed', { productId });
    }
  } finally {
    clearTimeout(timer);
  }

  if (failed && reportFailure) {
    // emitMetric swallows its own failures; the catch keeps this emit's never-throws contract
    // from resting on that.
    await emitMetric(INGEST_FAILURE_METRIC.namespace, INGEST_FAILURE_METRIC.name, 1, { Stage: Config.STAGE }).catch(
      () => {}
    );
  }
}

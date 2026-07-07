import crypto from 'crypto';
import { OVERWATCH_ANALYTICS_SCHEMA_VERSION } from '@bike4mind/common';
import type { OverwatchUtm } from '@bike4mind/common';
import { Config } from '@server/utils/config';

const NOT_CONFIGURED = 'not-configured';
const EMIT_TIMEOUT_MS = 2_000;

export function isAnalyticsConfigured(): boolean {
  return (
    Config.B4M_ANALYTICS_ENABLED?.toLowerCase() !== 'false' &&
    !!Config.OVERWATCH_INGEST_URL &&
    Config.OVERWATCH_INGEST_URL !== NOT_CONFIGURED &&
    !!Config.OVERWATCH_INGEST_KEY &&
    Config.OVERWATCH_INGEST_KEY !== NOT_CONFIGURED &&
    !!Config.OVERWATCH_PSEUDONYM_SALT &&
    Config.OVERWATCH_PSEUDONYM_SALT !== NOT_CONFIGURED
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
  referrer?: string;
  utm?: OverwatchUtm;
}

export async function emitActiveEvent(opts: EmitOptions): Promise<void> {
  if (!isAnalyticsConfigured()) return;

  const eventId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const event = {
    eventId,
    schemaVersion: OVERWATCH_ANALYTICS_SCHEMA_VERSION,
    productId: 'bike4mind',
    userId: opts.pseudoUserId,
    sessionId: opts.sessionId,
    event: 'active',
    timestamp,
    ...(opts.referrer !== undefined && { referrer: opts.referrer }),
    ...(opts.utm !== undefined && { utm: opts.utm }),
    metadata: { userType: opts.userType },
  };

  const url = Config.OVERWATCH_INGEST_URL;
  const key = Config.OVERWATCH_INGEST_KEY;
  // isAnalyticsConfigured() above already checked both are set; narrows the type here.
  if (!url || !key) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMIT_TIMEOUT_MS);

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

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      // redirect: 'manual' surfaces a 3xx as an opaque-redirect response (status 0), which never
      // reaches the receiver and is almost always a misconfigured OVERWATCH_INGEST_URL (scheme,
      // host, or trailing-slash redirect). Log it so the misconfig is diagnosable instead of every
      // emit silently dropping. Status only, never the key or body.
      console.warn('[b4m-analytics] ingest URL returned a redirect — check OVERWATCH_INGEST_URL', {
        status: res.status,
        productId: 'bike4mind',
      });
    } else if (res.status >= 400 && res.status < 500) {
      // Permanent client error - log status only, never the key or body
      console.warn('[b4m-analytics] permanent ingest error', { status: res.status, productId: 'bike4mind' });
    }
    // 503 / 5xx -> silent drop. Note: OverwatchUserDay's (productId, date, userId) upsert is
    // CROSS-INSTANCE dedup, not a retry - it suppresses duplicates once some emit has succeeded,
    // but it does not recover a user-day where every attempt failed. A user who touches only one
    // Lambda instance that day and whose single emit fails is simply absent from DAU for that day.
    // Acceptable for best-effort telemetry; high-traffic users self-heal across instances.
  } catch {
    // Network error or AbortController timeout -> silent drop
  } finally {
    clearTimeout(timer);
  }
}

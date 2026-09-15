import {
  EmbedBrandingSchema,
  parseEmbedOrigin,
  isOriginUnderHost,
  EMBED_ORIGINS_MAX,
  type IEmbedBranding,
} from '@bike4mind/common';
import { PUBLISH_HOST } from './validateBundle';

export type EmbedOriginsResult = { ok: true; value: string[] } | { ok: false; error: string; code: string };

/**
 * Shared host-aware screen for an embed-origin allowlist write. Layers on top of
 * the common EmbedOriginsSchema (format/dedup/max) the rules that need runtime
 * state the schema can't see: parse+canonicalize each origin, and reject any
 * origin under our own app/usercontent host. Framing by our own origins is
 * already covered by `frame-ancestors 'self'` plus the app host, and (since
 * usercontent is a subdomain of the app host) one suffix check against
 * PUBLISH_HOST covers both. The self-host rule is intentionally a no-op when
 * PUBLISH_HOST is empty: that only happens when SERVER_DOMAIN is unset, i.e. an
 * unbranded local/dev/fork deployment that has NO first-party host to protect and
 * whose serve layer already falls back to the same-origin srcdoc model (see
 * validateBundle.ts, whose own host allowlists fail closed the same way). A real
 * deployment always sets SERVER_DOMAIN, so this rule is active in every branded env.
 * Returns the normalized, deduped origin list.
 */
function screenEmbedOrigins(raw: string[]): EmbedOriginsResult {
  // A hand-crafted request body can send a non-array here; guard so a bad type
  // becomes a 4xx instead of a TypeError in the loop below (which would 500).
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'allowedOrigins must be an array of https origins', code: 'EMBED_ORIGIN_INVALID' };
  }
  const normalized: string[] = [];
  for (const origin of raw) {
    const parsed = parseEmbedOrigin(origin);
    if (!parsed) {
      return { ok: false, error: `Invalid embed origin: ${origin}`, code: 'EMBED_ORIGIN_INVALID' };
    }
    if (PUBLISH_HOST && isOriginUnderHost(parsed, PUBLISH_HOST)) {
      return { ok: false, error: 'Cannot grant embedding to a Bike4Mind host', code: 'EMBED_ORIGIN_SELF' };
    }
    normalized.push(parsed);
  }
  const deduped = [...new Set(normalized)];
  if (deduped.length > EMBED_ORIGINS_MAX) {
    return { ok: false, error: `At most ${EMBED_ORIGINS_MAX} embed origins are allowed`, code: 'EMBED_ORIGIN_LIMIT' };
  }
  return { ok: true, value: deduped };
}

/**
 * Server-authoritative validation for an embed-allowlist write on a PUBLISHED
 * ARTIFACT. The shared origin screen plus the artifact-only rule that a non-empty
 * allowlist requires an OPEN public artifact: a gated page is served no-store and
 * must never be framed, so embed grants there are a configuration mistake - fail
 * loud rather than silently never apply. Returns the normalized, deduped origin
 * list (empty when cleared/unset).
 */
export function validateEmbedOrigins(raw: string[] | undefined, ctx: { isOpenPublic: boolean }): EmbedOriginsResult {
  if (raw === undefined) return { ok: true, value: [] };
  const screened = screenEmbedOrigins(raw);
  if (!screened.ok) return screened;
  if (screened.value.length > 0 && !ctx.isOpenPublic) {
    return {
      ok: false,
      error: 'Embedding requires an open public artifact (no passphrase or domain gate)',
      code: 'EMBED_REQUIRES_OPEN_PUBLIC',
    };
  }
  return screened;
}

/**
 * Server-authoritative validation for an EMBED KEY's origin allowlist (epic #41).
 * Same host rules as an artifact allowlist (format/self-host/dedup/max) but with
 * NO open-public gate - an embed key is not a published artifact. Returns the
 * normalized, deduped origin list (empty when cleared/unset).
 */
export function validateEmbedKeyOrigins(raw: string[] | undefined): EmbedOriginsResult {
  if (raw === undefined) return { ok: true, value: [] };
  return screenEmbedOrigins(raw);
}

export type EmbedBrandingResult =
  { ok: true; value: IEmbedBranding | undefined } | { ok: false; error: string; code: string };

/**
 * Route-level screen for an embed key's branding write (epic #41 Phase D).
 * Same shared schema the service re-validates (hex-only primaryColor, https-only
 * logoUrl, length caps); screening here too keeps the route contract observable
 * (a 400 with a message, not a service-layer throw) and mirrors how
 * validateEmbedKeyOrigins is layered.
 */
export function validateEmbedBranding(raw: unknown): EmbedBrandingResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = EmbedBrandingSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') || 'branding';
    return {
      ok: false,
      error: `Invalid branding: ${field}: ${first?.message ?? 'invalid'}`,
      code: 'EMBED_BRANDING_INVALID',
    };
  }
  return { ok: true, value: parsed.data };
}

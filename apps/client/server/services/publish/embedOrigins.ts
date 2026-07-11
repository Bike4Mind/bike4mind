import { parseEmbedOrigin, isOriginUnderHost, EMBED_ORIGINS_MAX } from '@bike4mind/common';
import { PUBLISH_HOST } from './validateBundle';

export type EmbedOriginsResult = { ok: true; value: string[] } | { ok: false; error: string; code: string };

/**
 * Server-authoritative validation for an embed-allowlist write. Layers on top of
 * the common EmbedOriginsSchema (format/dedup/max) the two rules that need
 * runtime state the schema can't see:
 *   1. Reject any origin under our own app/usercontent host. Framing by our own
 *      origins is already covered by `frame-ancestors 'self'` plus the app host,
 *      and (since usercontent is a subdomain of the app host) one suffix check
 *      against PUBLISH_HOST covers both.
 *   2. A non-empty allowlist requires an OPEN public artifact. A gated page is
 *      served no-store and must never be framed, so embed grants there are a
 *      configuration mistake - fail loud rather than silently never apply.
 *
 * Returns the normalized, deduped origin list (empty when cleared/unset).
 */
export function validateEmbedOrigins(raw: string[] | undefined, ctx: { isOpenPublic: boolean }): EmbedOriginsResult {
  if (raw === undefined) return { ok: true, value: [] };

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
  if (deduped.length > 0 && !ctx.isOpenPublic) {
    return {
      ok: false,
      error: 'Embedding requires an open public artifact (no passphrase or domain gate)',
      code: 'EMBED_REQUIRES_OPEN_PUBLIC',
    };
  }
  return { ok: true, value: deduped };
}

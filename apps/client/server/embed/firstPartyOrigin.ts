import { isOriginPermitted } from '@bike4mind/common';
import { PUBLISH_HOST } from '@server/services/publish/validateBundle';

/**
 * Whether a browser Origin is our own serving host, i.e. the embed widget page
 * we serve from /embed/* (pages/api/embed/serve.ts). A same-origin POST still
 * sends an Origin header, and the app host can never be on a key's
 * allowedOrigins (validateEmbedKeyOrigins rejects self-host grants), so without
 * this exemption the widget's own mint/chat calls would 403 on every deployment.
 *
 * The credential stays the security boundary: a non-browser caller can omit
 * Origin entirely and is already let through, so permitting our own origin adds
 * no attack surface. Every embed origin gate decides through
 * resolveEmbedOriginDecision below, so they cannot drift.
 *
 * EXACT host match only - deliberately NOT a subtree match on PUBLISH_HOST. The
 * widget page is served from exactly `app.<domain>`, so an exact match is all
 * the first-party flow needs; a subtree match would also trust
 * `{publicId}.usercontent.app.<domain>`, which serves untrusted customer-published
 * bundles (the read-time mirror of the write-time self-host rejection in
 * embedOrigins.ts). Never widen this to the app subtree.
 *
 * Two matches:
 * - hostname === PUBLISH_HOST (branded deployments; PUBLISH_HOST is portless).
 * - host === the request's own Host header (unbranded local/dev stacks where
 *   PUBLISH_HOST is empty; Host may carry a port, so compare host-with-port).
 */
export function isFirstPartyEmbedOrigin(
  origin: string,
  requestHost: string | undefined,
  publishHost: string = PUBLISH_HOST
): boolean {
  let url: URL;
  try {
    url = new URL(origin.trim().toLowerCase());
  } catch {
    return false;
  }
  if (publishHost && url.hostname === publishHost.toLowerCase()) return true;
  if (requestHost && url.host === requestHost.trim().toLowerCase()) return true;
  return false;
}

/**
 * A present, non-opaque browser Origin passes when it is our own serving origin
 * OR on the key's allow-list. Only called through resolveEmbedOriginDecision.
 */
export function isEmbedOriginAllowed(
  origin: string,
  allowedOrigins: string[] | undefined,
  requestHost: string | undefined
): boolean {
  return isFirstPartyEmbedOrigin(origin, requestHost) || isOriginPermitted(origin, allowedOrigins);
}

/**
 * Single origin decision for every embed gate (session, history, chat). An absent
 * Origin is a non-browser caller and is left to the credential. The opaque literal
 * `null` is denied when the key restricts origins, and otherwise treated as absent.
 * Any other Origin goes through isEmbedOriginAllowed.
 */
export function resolveEmbedOriginDecision(
  rawOrigin: string | undefined,
  allowedOrigins: string[] | undefined,
  requestHost: string | undefined
): { allowed: boolean } {
  if (!rawOrigin) return { allowed: true };
  if (rawOrigin === 'null') return { allowed: !allowedOrigins?.length };
  return { allowed: isEmbedOriginAllowed(rawOrigin, allowedOrigins, requestHost) };
}

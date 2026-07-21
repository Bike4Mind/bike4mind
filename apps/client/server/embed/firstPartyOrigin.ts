import { isOriginUnderHost } from '@bike4mind/common';
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
 * no attack surface. Must stay in lockstep across BOTH origin gates:
 * pages/api/embed/session.ts and server/chatCompletion/external/embedRoute.ts.
 *
 * Two matches, in order:
 * - Origin under PUBLISH_HOST (branded deployments; robust behind CloudFront,
 *   where the upstream Host header may be an internal one).
 * - Origin host equals the request's own Host header (covers unbranded
 *   local/dev stacks where PUBLISH_HOST is empty and the origin is http).
 */
export function isFirstPartyEmbedOrigin(
  origin: string,
  requestHost: string | undefined,
  publishHost: string = PUBLISH_HOST
): boolean {
  if (publishHost && isOriginUnderHost(origin, publishHost)) return true;
  if (!requestHost) return false;
  let originHost: string;
  try {
    originHost = new URL(origin.trim().toLowerCase()).host;
  } catch {
    return false;
  }
  return originHost === requestHost.trim().toLowerCase();
}

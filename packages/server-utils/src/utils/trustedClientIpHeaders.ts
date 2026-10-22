// The forwarding-header reads that can be trusted, with no imports so proxy.ts can use them without
// pulling @bike4mind/fab-pipeline (OpenSearch, storage, dns) into every request. The full resolver,
// with the fallback header chain and the socket address, is getClientIp in ./ip.ts.

export const TRUSTED_PROXY_HOPS_ENV = 'TRUSTED_PROXY_HOPS';

export type HeaderReader = (name: string) => string | null | undefined;

export function isSelfHost(): boolean {
  return process.env.B4M_SELF_HOST === 'true';
}

export function stripPort(token: string): string {
  // Strip bracketed IPv6 with port (e.g., [::1]:8080 -> ::1) or IPv4 port (e.g., 1.2.3.4:8080 -> 1.2.3.4).
  // The second regex only matches IPv4 ports - requires digits.digits before the colon to avoid corrupting bare IPv6.
  return token.replace(/^\[(.*)](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
}

// Throws on a malformed value rather than guessing: falling back to 0 would silently undo the
// operator's proxy setup, and any other fallback would silently trust spoofable headers.
// instrumentation.ts calls this at boot so a bad value fails the server instead of every request.
export function readTrustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV]?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${TRUSTED_PROXY_HOPS_ENV} must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

// Each trusted proxy appends the peer it saw, so the client is the token `hops` places from the
// right; anything left of it is client-supplied. With fewer tokens than hops, the leftmost is the
// furthest address any proxy vouched for (same rule as Express's numeric `trust proxy`).
export function getTrustedForwardedForIp(readHeader: HeaderReader, hops: number): string | null {
  if (hops === 0) return null;
  const tokens = (readHeader('x-forwarded-for') ?? '')
    .split(',')
    .map(token => stripPort(token.trim()))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens[Math.max(0, tokens.length - hops)];
}

// CloudFront sets `cloudfront-viewer-address` to the real TCP peer as `<ip>:<port>` and overwrites
// any client-supplied value, so it is the authoritative, unspoofable client IP on deployed stages.
// Our CloudFront config does not append to `x-forwarded-for`, so XFF's leftmost token is whatever
// the client sent.
export function getCloudFrontViewerIp(readHeader: HeaderReader): string | null {
  const viewer = readHeader('cloudfront-viewer-address')?.trim();
  if (!viewer) return null;
  // CloudFront delivers this as unbracketed IPv6/IPv4 plus a decimal ephemeral port, so the
  // trailing `:<digits>` is always the port. Do not reuse this regex on a port-less value - it
  // would strip a final IPv6 hextet.
  return viewer.replace(/:\d+$/, '') || null;
}

/**
 * The client IP from forwarding headers alone, or null when no header can be trusted. For callers
 * without a socket (the Next.js proxy); a null here is where getClientIp would fall back to the
 * socket address.
 */
export function getTrustedHeaderClientIp(readHeader: HeaderReader): string | null {
  if (isSelfHost()) return getTrustedForwardedForIp(readHeader, readTrustedProxyHops());
  return getCloudFrontViewerIp(readHeader);
}

import { isPrivateIP } from '@bike4mind/fab-pipeline';

// Extracts the most accurate client IP behind proxies/CDNs.
//
// Deployed stages: CloudFront viewer address, then Cloudflare, Akamai/proxies, X-Forwarded-For
// (first), Fly, then socket addresses. Filters out private/reserved ranges and strips ports. The
// filter is `isPrivateIP` from `@bike4mind/fab-pipeline` (so this file doesn't carry its own IPv6
// prefix list to drift out of sync with it - see #1969) - it is an SSRF-destination guard, so it is
// also wider than routability alone (e.g. CGNAT, 6to4/Teredo, documentation ranges): a header value
// in one of those ranges is treated as untrustworthy here too and the resolver falls through.
//
// Self-host (`B4M_SELF_HOST=true`): there is no CDN guaranteed to overwrite those headers, so a
// client could mint a fresh "source IP" per request and void every per-IP rate limit. Forwarding
// headers are ignored unless the operator declares `TRUSTED_PROXY_HOPS` (see SELF_HOST.md and
// compose.caddy.yaml, which sets it for the bundled Caddy proxy).

const TRUSTED_PROXY_HOPS_ENV = 'TRUSTED_PROXY_HOPS';

/**
 * The parts of a request the resolver reads. Structural so an express Request, a NextApiRequest
 * and a bare IncomingMessage all fit without a cast; `ip` is express-only.
 */
export type ClientIpRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
  connection?: { remoteAddress?: string } | null;
  ip?: string;
};

function stripPort(token: string): string {
  // Strip bracketed IPv6 with port (e.g., [::1]:8080 -> ::1) or IPv4 port (e.g., 1.2.3.4:8080 -> 1.2.3.4).
  // The second regex only matches IPv4 ports - requires digits.digits before the colon to avoid corrupting bare IPv6.
  return token.replace(/^\[(.*)](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
}

function cleanIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // If multiple IPs, take the first non-empty
  const candidate = raw.split(',')[0]?.trim();
  if (!candidate) return null;
  return stripPort(candidate) || null;
}

function isSelfHost(): boolean {
  return process.env.B4M_SELF_HOST === 'true';
}

// Throws on a malformed value rather than guessing: falling back to 0 would silently undo the
// operator's proxy setup, and any other fallback would silently trust spoofable headers.
function readTrustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV]?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${TRUSTED_PROXY_HOPS_ENV} must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

function getSocketIp(req: ClientIpRequest): string {
  const socketIp = cleanIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (socketIp) return socketIp;
  return req.ip || 'unknown';
}

// Each trusted proxy appends the peer it saw, so the client is the token `hops` places from the
// right; anything left of it is client-supplied. With fewer tokens than hops, the leftmost is the
// furthest address any proxy vouched for (same rule as Express's numeric `trust proxy`).
function getSelfHostClientIp(req: ClientIpRequest): string {
  const hops = readTrustedProxyHops();
  if (hops === 0) return getSocketIp(req);

  const forwardedFor = req.headers?.['x-forwarded-for'];
  const tokens = (typeof forwardedFor === 'string' ? forwardedFor : '')
    .split(',')
    .map(token => stripPort(token.trim()))
    .filter(Boolean);
  if (tokens.length === 0) return getSocketIp(req);

  return tokens[Math.max(0, tokens.length - hops)];
}

export function getClientIp(req: ClientIpRequest): string {
  if (isSelfHost()) return getSelfHostClientIp(req);

  // CloudFront sets `cloudfront-viewer-address` to the real TCP peer as
  // `<ip>:<port>` and overwrites any client-supplied value, so it is the
  // authoritative, unspoofable client IP. Checked first because our CloudFront
  // config does not append to `x-forwarded-for` - the origin sees only what the
  // client sent, so trusting XFF's leftmost token would record a spoofed IP.
  // The port is always the trailing `:<digits>` for both IPv4 and IPv6 forms.
  const cfViewer = req.headers?.['cloudfront-viewer-address'];
  if (typeof cfViewer === 'string' && cfViewer.trim()) {
    // CloudFront delivers this as unbracketed IPv6/IPv4 plus a decimal ephemeral
    // port, so the trailing `:<digits>` is always the port. Do not reuse this
    // regex on a port-less value - it would strip a final IPv6 hextet.
    const ip = cfViewer.trim().replace(/:\d+$/, '');
    if (ip) return ip;
  }

  const headerOrder = [
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip',
    'x-client-ip',
    'x-forwarded-for',
    'fly-client-ip',
  ] as const;

  for (const header of headerOrder) {
    // Callers may pass a NextApiRequest-like object whose `headers` is absent
    // (e.g. some handler/test contexts); without this guard the loop throws.
    const ip = cleanIp(req.headers?.[header] as string | undefined);
    if (ip && !isPrivateIP(ip)) return ip;
  }

  return getSocketIp(req);
}

/**
 * Truncate an IP address for privacy (GDPR Breyer ruling compliance).
 * IPv4: zeros the last octet (e.g., 192.168.1.42 -> 192.168.1.0)
 * IPv6: keeps first 3 groups, zeros the rest (/48 mask)
 *
 * Applied only to telemetry audit logs. Security/integration audit logs
 * retain full IPs under a stronger legitimate interest basis (fraud/intrusion detection).
 */
export function truncateIp(ip: string): string {
  if (!ip || ip === 'unknown') return ip;

  // IPv6: expand compressed notation, keep first 3 groups (/48), zero the rest
  if (ip.includes(':')) {
    let expanded = ip;
    if (expanded.includes('::')) {
      const halves = expanded.split('::');
      const left = halves[0] ? halves[0].split(':') : [];
      const right = halves[1] ? halves[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      expanded = [...left, ...Array(missing).fill('0'), ...right].join(':');
    }
    const parts = expanded.split(':');
    return parts
      .slice(0, 3)
      .concat(Array(Math.max(0, parts.length - 3)).fill('0'))
      .join(':');
  }

  // IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    parts[3] = '0';
    return parts.join('.');
  }

  return ip;
}

export default getClientIp;

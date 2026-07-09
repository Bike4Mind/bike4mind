import type { Request } from 'express';

// Extracts the most accurate client IP behind proxies/CDNs.
// Priority: Cloudflare, Akamai/proxies, X-Forwarded-For (first), Fly, then socket addresses.
// Filters out private/reserved ranges and strips ports.

const PRIVATE_IPV4_RANGES: RegExp[] = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^192\.168\./];

// Loopback (::1 and its fully-expanded 0:0:0:0:0:0:0:1 form), unspecified (::),
// link-local (fe80::/10 -> fe80..febf), and unique-local (fc00::/7 -> fc00..fdff).
// Matched case-insensitively on the leading hextets.
const PRIVATE_IPV6_RANGES: RegExp[] = [
  /^::1$/i,
  /^(?:0{1,4}:){7}0{0,3}1$/i,
  /^::$/,
  /^fe[89ab][0-9a-f]:/i,
  /^f[cd][0-9a-f]{2}:/i,
];

// Matches the ::ffff:<IPv4> mapped prefix so we can re-check the embedded dotted
// IPv4 against the private ranges. The exotic hex-encoded mapped form
// (::ffff:0a00:0001) is intentionally not normalized - see follow-up.
const IPV4_MAPPED_PREFIX = /^::ffff:/i;

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IPV4_RANGES.some(r => r.test(ip))) return true;
  if (PRIVATE_IPV6_RANGES.some(r => r.test(ip))) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.1): strip the prefix and re-test as IPv4.
  const mapped = ip.replace(IPV4_MAPPED_PREFIX, '');
  return mapped !== ip && PRIVATE_IPV4_RANGES.some(r => r.test(mapped));
}

function cleanIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // If multiple IPs, take the first non-empty
  const candidate = raw.split(',')[0]?.trim();
  if (!candidate) return null;
  // Strip bracketed IPv6 with port (e.g., [::1]:8080 -> ::1) or IPv4 port (e.g., 1.2.3.4:8080 -> 1.2.3.4).
  // The second regex only matches IPv4 ports - requires digits.digits before the colon to avoid corrupting bare IPv6.
  const withoutPort = candidate.replace(/^\[(.*)](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
  return withoutPort || null;
}

export function getClientIp(req: Request): string {
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
    if (ip && !isPrivateIp(ip)) return ip;
  }

  const socketIp = cleanIp((req.socket as any)?.remoteAddress || (req.connection as any)?.remoteAddress);
  if (socketIp) return socketIp;

  return req.ip || 'unknown';
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

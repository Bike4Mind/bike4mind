import { isPrivateIP } from '@bike4mind/fab-pipeline';
import {
  type CloudFrontViewerNetwork,
  getCloudFrontViewerIp,
  getCloudFrontViewerNetwork,
  getTrustedForwardedForIp,
  type HeaderReader,
  isSelfHost,
  readTrustedProxyHops,
  stripPort,
} from './trustedClientIpHeaders';

export type { CloudFrontViewerNetwork };

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
// compose.caddy.yaml, which sets it for the bundled Caddy proxy). The trusted reads live in
// ./trustedClientIpHeaders so the Next.js proxy can share them.

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

function cleanIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // If multiple IPs, take the first non-empty
  const candidate = raw.split(',')[0]?.trim();
  if (!candidate) return null;
  return stripPort(candidate) || null;
}

function getSocketIp(req: ClientIpRequest): string {
  const socketIp = cleanIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (socketIp) return socketIp;
  return req.ip || 'unknown';
}

function headerReader(req: ClientIpRequest): HeaderReader {
  return name => {
    const value = req.headers?.[name];
    return typeof value === 'string' ? value : undefined;
  };
}

const UNTRUSTED_HEADER_ORDER = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-client-ip',
  'x-forwarded-for',
  'fly-client-ip',
] as const;

/** The viewer ASN and country CloudFront forwarded for this request; nulls when absent or self-hosted. */
export function getClientNetwork(req: ClientIpRequest): CloudFrontViewerNetwork {
  return getCloudFrontViewerNetwork(headerReader(req));
}

export function getClientIp(req: ClientIpRequest): string {
  const readHeader = headerReader(req);
  if (isSelfHost()) return getTrustedForwardedForIp(readHeader, readTrustedProxyHops()) ?? getSocketIp(req);

  const viewerIp = getCloudFrontViewerIp(readHeader);
  if (viewerIp) return viewerIp;

  for (const header of UNTRUSTED_HEADER_ORDER) {
    const ip = cleanIp(readHeader(header));
    if (ip && !isPrivateIP(ip)) return ip;
  }

  return getSocketIp(req);
}

/**
 * Truncate an IP address for privacy (GDPR Breyer ruling compliance).
 * IPv4: zeros the last octet (e.g., 192.168.1.42 -> 192.168.1.0)
 * IPv6: keeps first 3 groups, zeros the rest (/48 mask)
 * IPv4-mapped/translated IPv6: truncates the embedded IPv4 (::ffff:192.168.1.42 -> ::ffff:192.168.1.0),
 * compressed or expanded, for ::ffff:0:0/96 and ::ffff:0:0:0/96
 * Idempotent: truncating a truncated address returns it unchanged.
 *
 * Applied to telemetry audit logs, and to the signup IP once it passes its retention window
 * (apps/workers/src/cron/signupIpRetention.ts). Security/integration audit logs
 * retain full IPs under a stronger legitimate interest basis (fraud/intrusion detection).
 */
export function truncateIp(ip: string): string {
  if (!ip || ip === 'unknown') return ip;

  // IPv4-mapped IPv6 (a dual-stack socket's remoteAddress): truncate the embedded IPv4. The /48
  // rule below would zero every group and lose the network entirely.
  const mapped = /^((?:(?:0{1,4}:){5}|::)ffff:|(?:(?:0{1,4}:){4}|::)ffff:0{1,4}:)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return `${mapped[1]}${truncateIp(mapped[2])}`;

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

import { isIP } from 'node:net';
import { parseBaseUrl } from '../http';

/**
 * Where an address points. 'tailscale' is Tailscale's IPv6 range only: 100.64.0.0/10 is shared with
 * carrier-grade NAT and other networks, so it counts as 'private'.
 */
export type AddressScope = 'loopback' | 'tailscale' | 'private' | 'public';

/** Most trusted first; a name that resolves to several addresses takes the least trusted one. */
const SCOPE_ORDER: readonly AddressScope[] = ['loopback', 'tailscale', 'private', 'public'];

export function leastTrusted(scopes: readonly AddressScope[]): AddressScope {
  return scopes.reduce<AddressScope>(
    (worst, scope) => (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(worst) ? scope : worst),
    'loopback'
  );
}

function ipv4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

/** The 8 16-bit groups of an IPv6 address, or null. Handles `::` and a trailing dotted IPv4. */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const bytes = ipv4Bytes(dotted[1]);
    if (!bytes) return null;
    text = `${text.slice(0, -dotted[1].length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (part: string | undefined) => (part ? part.split(':').map(group => parseInt(group, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  const groups = tail === undefined ? front : [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function scopeOfIpv4([a, b]: number[]): AddressScope {
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  return 'public';
}

/** Scope of an IP literal (IPv4, IPv6, or IPv4-mapped IPv6); null when `ip` is not an IP. */
export function scopeOfIp(ip: string): AddressScope | null {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = ipv4Bytes(bare);
  if (v4) return scopeOfIpv4(v4);
  const groups = ipv6Groups(bare);
  if (!groups) return null;
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return 'loopback';
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return scopeOfIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if (groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0) return 'tailscale';
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

export type TransportVerdict = { ok: true; unencrypted: boolean } | { ok: false; reason: string };

/**
 * Whether a request may go out. https is always allowed (the certificate is checked as usual). Plain
 * http is refused to public addresses, and carries credentials only to loopback and Tailscale IPv6.
 */
export function transportVerdict(protocol: string, scope: AddressScope, hasCredentials: boolean): TransportVerdict {
  if (protocol === 'https:') return { ok: true, unencrypted: false };
  if (protocol !== 'http:') return { ok: false, reason: 'Use an http or https address.' };
  if (scope === 'loopback' || scope === 'tailscale') return { ok: true, unencrypted: false };
  if (scope === 'public') {
    return {
      ok: false,
      reason: 'This address is on the public internet. Use https so the connection is encrypted.',
    };
  }
  if (hasCredentials) {
    return {
      ok: false,
      reason:
        'Credentials are only sent over https, or over http to this computer or a Tailscale IPv6 address. Use https for this server.',
    };
  }
  return { ok: true, unencrypted: true };
}

export interface ParsedAddress {
  /** Canonical base URL: scheme, host, port, and any proxy path. */
  baseUrl: string;
  protocol: 'http:' | 'https:';
  /** Host without IPv6 brackets. */
  host: string;
  origin: string;
}

/** `https://host`, `http://192.168.1.5:11434` or `host:port` (http). Null for anything else, including `user:pass@`. */
export function parseServerAddress(address: string): ParsedAddress | null {
  // parseBaseUrl drops a query or fragment; a server address has neither, so refuse instead of guessing.
  if (/[?#]/.test(address)) return null;
  const baseUrl = parseBaseUrl(address);
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { baseUrl, protocol: url.protocol as 'http:' | 'https:', host, origin: url.origin };
}

/** A short default name: the host without a trailing domain for names, the address for IPs. */
export function suggestServerName(parsed: ParsedAddress): string {
  if (isIP(parsed.host)) return parsed.host;
  return parsed.host.split('.')[0] || parsed.host;
}

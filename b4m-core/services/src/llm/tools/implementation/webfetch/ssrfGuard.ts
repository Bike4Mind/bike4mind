import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for the direct server-side fetch that `probeLlmsTxt` performs.
 *
 * The main web_fetch path is SSRF-immune by construction (Firecrawl does the fetching on its own
 * infra). The llms.txt probe is the only place this service dials a user/model-supplied origin
 * directly, so it must reject private/loopback/link-local/cloud-metadata targets. Mirrors the
 * hostname checks in apps/client/pages/api/external-image.ts and adds a resolved-address check,
 * because this path has no admin gate. Callers must also use `redirect: 'error'` so a public
 * origin cannot 302-pivot to an internal address after the check.
 *
 * A DNS-rebind race between this lookup and the actual connection is still theoretically possible;
 * matching the repo's accepted posture (external-image.ts), this is defense-in-depth on a
 * best-effort probe whose response body is never read.
 */

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) || // link-local + AWS metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast / reserved
  );
}

function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (h.includes('ffff:')) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) dials the underlying IPv4 - treat conservatively.
    const tail = h.split(':').pop() ?? '';
    return tail.includes('.') ? isPrivateIpv4(tail) : true;
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return (
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe8') ||
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb')
  );
}

function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/** Literal-hostname check (no DNS). Returns a reason string when unsafe, else null. */
export function unsafeHostnameReason(hostname: string): string | null {
  const raw = hostname.toLowerCase();
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return 'loopback host';
  }
  if (host.includes('ffff:')) {
    return 'ipv4-mapped ipv6 address';
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) {
    return 'private/reserved ipv4 address';
  }
  if (host.includes(':') && isPrivateIpv6(host)) {
    return 'private/reserved ipv6 address';
  }
  return null;
}

/**
 * Full guard: protocol + literal hostname + resolved-address check. Returns a reason string when
 * the URL is unsafe to fetch server-side, or null when it is safe.
 */
export async function unsafeFetchUrlReason(url: URL): Promise<string | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'unsupported protocol';
  }
  const literal = unsafeHostnameReason(url.hostname);
  if (literal) return literal;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = await lookup(host, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) return 'resolves to a private/reserved address';
    }
  } catch {
    return 'dns resolution failed';
  }
  return null;
}

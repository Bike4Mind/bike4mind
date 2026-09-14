/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Provides validation functions to prevent SSRF attacks by blocking
 * requests to internal/private networks, cloud metadata endpoints,
 * and other sensitive destinations.
 *
 * Used by webhook delivery and test endpoints.
 */

import dns from 'dns';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/**
 * Check if an IPv4 address is in a private/internal range.
 */
function isPrivateIPv4(ip: string): boolean {
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;

  const [, a, b, c] = ipv4Match.map(Number);

  // 10.0.0.0/8 - Private network
  if (a === 10) return true;

  // 172.16.0.0/12 - Private network
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 - Private network
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 - Link-local (includes AWS metadata)
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  // 100.64.0.0/10 - Shared address space (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 - Documentation
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
    return true;

  // 198.18.0.0/15 - RFC 2544 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 224.0.0.0/4 - Multicast
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 - Reserved
  if (a >= 240) return true;

  return false;
}

// Build the dotted IPv4 from the two 16-bit hex groups an IPv6 literal embeds it in
// (e.g. `7f00` + `1` -> `127.0.0.1`).
function hexPairToIpv4(hi: string, lo: string): string {
  const high = parseInt(hi, 16);
  const low = parseInt(lo, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Check if an IPv6 address is in a private/internal range.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 - Loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // :: - Unspecified address
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // fe00::/8 - link-local (fe80::/10), deprecated site-local (fec0::/10, RFC 3879) and the
  // reserved remainder. None of fe00::/8 is global-unicast, so block the whole /8: matching only
  // fe8-feb left fec0::/10 site-local as a hole with no DNS backstop (IPv6 literals skip resolve).
  if (normalized.startsWith('fe')) return true;

  // fc00::/7 - Unique local addresses (ULA) - includes fc00::/8 and fd00::/8
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // ff00::/8 - Multicast
  if (normalized.startsWith('ff')) return true;

  // All three IPv6 forms that embed an IPv4 address route to that IPv4, so re-check the
  // embedded address (the one fetch() actually dials) instead of trusting the wrapper. WHATWG
  // `new URL()` never emits the dotted spelling; it hexifies (::ffff:127.0.0.1 -> ::ffff:7f00:1),
  // so match the hex form too or the check is dead for every URL-derived host.

  // ::ffff:0:0/96 - IPv4-mapped. Any non-embedding ::ffff: shape fails closed.
  if (normalized.startsWith('::ffff:')) {
    const rest = normalized.slice('::ffff:'.length);
    const dotted = rest.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isPrivateIPv4(dotted[1]);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) return isPrivateIPv4(hexPairToIpv4(hex[1], hex[2]));
    return true;
  }

  // ::/96 - IPv4-compatible (deprecated). ::, ::1 and ::ffff: are handled above; any other
  // ::-prefixed literal has zero high bits and embeds an IPv4 (::127.0.0.1 -> ::7f00:1 dials
  // loopback). Unknown ::-prefixed shape fails closed.
  if (normalized.startsWith('::')) {
    const rest = normalized.slice(2);
    const dotted = rest.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isPrivateIPv4(dotted[1]);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) return isPrivateIPv4(hexPairToIpv4(hex[1], hex[2]));
    const single = rest.match(/^([0-9a-f]{1,4})$/);
    if (single) return isPrivateIPv4(hexPairToIpv4('0', single[1]));
    return true;
  }

  // 2002::/16 - 6to4. Embeds the IPv4 in the two groups after the 2002 prefix
  // (2002:7f00:1:: -> 127.0.0.1). A malformed 6to4 literal fails closed.
  if (normalized.startsWith('2002:')) {
    const groups = normalized.slice('2002:'.length).split(':');
    if (/^[0-9a-f]{1,4}$/.test(groups[0]) && /^[0-9a-f]{1,4}$/.test(groups[1] ?? '')) {
      return isPrivateIPv4(hexPairToIpv4(groups[0], groups[1]));
    }
    return true;
  }

  // 2001:db8::/32 - Documentation
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:')) return true;

  // 100::/64 - Discard prefix
  if (normalized.startsWith('100::') || normalized.startsWith('0100::')) return true;

  // 64:ff9b::/96 - IPv4/IPv6 translation (could embed private IPv4)
  // For safety, block this prefix entirely
  if (normalized.startsWith('64:ff9b:') || normalized.startsWith('0064:ff9b:')) return true;

  return false;
}

/**
 * Check if an IP address (IPv4 or IPv6) is in a private/internal range.
 */
export function isPrivateIP(ip: string): boolean {
  // Check if it's IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return isPrivateIPv4(ip);
  }

  // Assume IPv6
  return isPrivateIPv6(ip);
}

/**
 * Check if a hostname is known to be private/internal.
 * This catches obvious cases before DNS resolution.
 */
export function isPrivateOrInternalHostname(hostname: string): boolean {
  // URL.hostname wraps IPv6 literals in brackets ([::1]) and a hostname may carry a
  // trailing dot (the FQDN root label, e.g. `localhost.`); strip both so the checks below
  // match the bare address/name instead of missing on the brackets or the dot.
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

  // Block localhost variations
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  // Block AWS metadata endpoint
  if (
    normalized === '169.254.169.254' ||
    normalized === 'instance-data' ||
    normalized === 'metadata.google.internal' ||
    normalized === 'metadata.internal'
  ) {
    return true;
  }

  // Block Kubernetes internal DNS
  if (
    normalized.endsWith('.cluster.local') ||
    normalized.endsWith('.svc.cluster.local') ||
    normalized.endsWith('.pod.cluster.local')
  ) {
    return true;
  }

  // Check if it's an IP address in private ranges
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(normalized)) {
    return isPrivateIPv4(normalized);
  }

  // Check if it's an IPv6 address
  if (normalized.includes(':')) {
    return isPrivateIPv6(normalized);
  }

  return false;
}

/**
 * Validate a URL for webhook delivery.
 * Blocks internal/private networks to prevent SSRF attacks.
 * Resolves DNS and validates resolved IPs to prevent DNS rebinding attacks.
 *
 * TOCTOU: DNS is resolved here, then Node resolves independently at connect time. An attacker who
 * controls the authoritative DNS for a host they themselves supply (e.g. a blog-integration baseUrl)
 * can pass this check on the first lookup and have the socket dial a private IP on the second - so
 * this validation does NOT on its own close rebinding for user-supplied hosts. What contains it is
 * that safeFetch's callers bound the bytes an upstream response can return (blog/publish.ts,
 * presign-image-upload.ts), leaving a blind connect oracle rather than an internal read. That is the
 * same residual the repo already accepts for https fetchers (b4m-core/.../webfetch/plainFetch.ts);
 * the full connect-time IP pin (ssrfSafeLookup in b4m-core/fab-pipeline) exists only for the
 * node-http/axios fetchers, which can install a validating lookup that global fetch here cannot.
 *
 * @param url - The URL to validate
 * @returns Object with valid flag and optional error message
 */
export async function validateTargetUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = new URL(url);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    // First check hostname directly (catches localhost, explicit IPs, etc.)
    if (isPrivateOrInternalHostname(parsed.hostname)) {
      return { valid: false, error: 'URL points to a private or internal network' };
    }

    // For non-IP hostnames, resolve DNS and validate all resolved IPs
    // This prevents DNS rebinding attacks where hostname resolves to private IP
    const isIPv4Address = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
    const isIPv6Address = parsed.hostname.includes(':');

    if (!isIPv4Address && !isIPv6Address) {
      try {
        // Try to resolve IPv4 addresses
        const ipv4Addresses = await dnsResolve4(parsed.hostname).catch(() => [] as string[]);

        // Try to resolve IPv6 addresses
        const ipv6Addresses = await dnsResolve6(parsed.hostname).catch(() => [] as string[]);

        const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

        if (allAddresses.length === 0) {
          return { valid: false, error: 'Could not resolve hostname' };
        }

        // Check ALL resolved IPs - block if ANY is private
        for (const ip of allAddresses) {
          if (isPrivateIP(ip)) {
            return { valid: false, error: `Hostname resolves to private IP address (${ip})` };
          }
        }
      } catch {
        return { valid: false, error: 'Could not resolve hostname' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Returns an `isAllowedHost(url)` predicate scoped to the given allowlist.
 * Matching is exact or subdomain: `makeAllowedHostChecker(['linkedin.com'])` allows
 * `api.linkedin.com` but not `lnkd.in` or `linkedin.com.evil.com`.
 *
 * @param allowedHosts - Exact hostnames or apex domains whose subdomains are also allowed
 */
export function makeAllowedHostChecker(allowedHosts: string[]): (url: string) => boolean {
  return (url: string) => {
    try {
      const { hostname } = new URL(url);
      return allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  };
}

/** Thrown by {@link safeFetch} when a target, or its redirect target, is unsafe to fetch. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Assert a caller/user-influenced URL is safe to fetch server-side, or throw SsrfError.
 * https-only, then defers to validateTargetUrl, which blocks private/internal hostnames AND
 * resolves DNS and rejects if any resolved IP is private - so a public NAME that resolves to a
 * private address (e.g. 127.0.0.1.nip.io) is caught, not just literal IPs. DNS resolution is I/O,
 * hence async. For fetch call sites use {@link safeFetch}, which also re-checks a redirect hop.
 *
 * @throws SsrfError with a human-readable reason if the URL is not allowed.
 */
export async function assertUrlAllowed(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError('not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfError('only https URLs are allowed');
  }
  const { valid, error } = await validateTargetUrl(url);
  if (!valid) {
    throw new SsrfError(error ?? 'points to a private or internal network');
  }
}

/**
 * Fetch a caller/user-influenced URL with SSRF protection on BOTH the initial host and a single
 * redirect hop. A plain fetch defaults to redirect:'follow', so a guard on the initial URL alone
 * is bypassed by a public host that 3xx-redirects to an internal one. This validates up front
 * (assertUrlAllowed, DNS-resolving), fetches with redirect:'manual', re-validates the Location the
 * same way, and follows at most one hop with redirect:'error'. Callers keep their own
 * timeout/size/content-type handling via `init` and the returned Response.
 *
 * @throws SsrfError if the target or its redirect target is unsafe.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await assertUrlAllowed(url);

  const response = await fetch(url, { ...init, redirect: 'manual' });
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }

  const location = response.headers.get('location');
  if (!location) {
    throw new SsrfError('redirect without a Location header');
  }
  const target = new URL(location, url).toString();
  try {
    await assertUrlAllowed(target);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new SsrfError(`blocked redirect: ${e.message}`);
    }
    throw e;
  }
  // One extra hop only: redirect:'error' rejects any further redirect from the target.
  return fetch(target, { ...init, redirect: 'error' });
}

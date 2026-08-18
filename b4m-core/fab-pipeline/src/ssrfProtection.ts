/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Provides validation functions to prevent SSRF attacks by blocking
 * requests to internal/private networks, cloud metadata endpoints,
 * and other sensitive destinations.
 *
 * Used by URL fetching in LLM context building to prevent users from
 * accessing internal network resources via prompts containing URLs.
 *
 * @see https://owasp.org/www-community/attacks/Server_Side_Request_Forgery
 */

import dns from 'dns';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/**
 * Check if an IPv4 address is in a private/internal range.
 */
function isPrivateIPv4(ip: string): boolean {
  // Ambiguity check FIRST, and against a looser shape than the canonical pattern below. A
  // non-canonical octet - one with a leading zero, e.g. `0177.0.0.1` - is treated as BLOCKED rather
  // than parsed: `Number('0177')` is 177 decimal, but an inet_aton-style parser reads it as octal and
  // gets 127, so the very same string can look public here and resolve to loopback in whatever stack
  // eventually dials it. We cannot know which reading the downstream resolver takes, so the ambiguity
  // itself is refused.
  //
  // It must be a SEPARATE, wider regex: `0177` is four digits, so it never matches the `\d{1,3}`
  // pattern below and would otherwise fall through as "not an IPv4 address at all" - which is exactly
  // how it slipped past. Canonical addresses never carry a leading zero, and a bare `0` octet still
  // does (length 1), so nothing legitimate is refused.
  const nonCanonical = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (nonCanonical && nonCanonical.slice(1).some(octet => octet.length > 1 && octet.startsWith('0'))) return true;

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

  // 169.254.0.0/16 - Link-local (includes AWS metadata endpoint)
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

/**
 * Check if an IPv6 address is in a private/internal range.
 */
/**
 * Strip the brackets WHATWG URL keeps on an IPv6 hostname: `new URL('http://[::1]/').hostname` is
 * `'[::1]'`, not `'::1'`. Every literal check below compares against unbracketed forms, so without
 * this a bracketed address matched nothing and fell through as safe.
 *
 * Same treatment as the sibling guards in this repo - `ssrfGuard.ts` and `external-image.ts` both
 * strip brackets before their literal checks.
 */
function stripIpv6Brackets(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = stripIpv6Brackets(ip);

  // ::1 - Loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // :: - Unspecified address
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // fe80::/10 - Link-local
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return true;

  // fc00::/7 - Unique local addresses (ULA) - includes fc00::/8 and fd00::/8
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // ff00::/8 - Multicast
  if (normalized.startsWith('ff')) return true;

  // ::ffff:0:0/96 - IPv4-mapped IPv6. These dial the underlying IPv4, so they must be judged by it.
  //
  // Anchored on the PREFIX, and it has to be: an `ffff` hextet is legal anywhere in an address, so a
  // substring test also refuses public ones like `2606:4700:ffff::1`. That over-block reaches further
  // than it looks, because `validateUrlForFetch` rejects a hostname if ANY resolved IP is private -
  // one `ffff` hextet in a dual-stack host's AAAA would sink its perfectly fine A record.
  //
  // Prefix matching still covers the case the dotted-quad regex used to miss: Node normalises
  // `::ffff:169.254.169.254` to the hex form `::ffff:a9fe:a9fe`, which is the cloud metadata endpoint,
  // i.e. instance credentials. When the tail is dotted we judge the embedded IPv4 exactly; when it is
  // hex we refuse rather than decode, which is what the sibling `ssrfGuard.ts` does too.
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.split(':').pop() ?? '';
    return tail.includes('.') ? isPrivateIPv4(tail) : true;
  }

  // ::/96 - IPv4-COMPATIBLE IPv6 (`::x.y.z.w`), the deprecated sibling of the mapped form above.
  // Node compresses the dotted spelling, so `[::169.254.169.254]` arrives as `[::a9fe:a9fe]` and
  // matches none of the family prefixes checked above.
  //
  // MUST stay below the `ffff:` branch: `::ffff:1.2.3.4` also starts with `::`, and judging it here
  // would take `ffff:1.2.3.4` as the tail and fail to recognise the embedded IPv4 at all.
  //
  // Exploitability is narrower than the mapped form and worth stating honestly: modern Linux does not
  // translate `::x.y.z.w` to the underlying IPv4 (RFC 4291 removed that), so this reaches an IPv6
  // socket rather than a v4-only metadata service. It is closed anyway because it is the same shape as
  // the bug above, the design intent stated for the mapped form applies identically, and an unusual
  // dual-stack or CNI configuration can still translate. `::1` and `::` are handled earlier.
  //
  // Deliberately WIDER than the `::/96` this branch is named for: `startsWith('::')` refuses anything
  // Node canonicalises to a leading `::`, not just the compatible range. Nothing legitimate is lost -
  // `::/8` is IANA-reserved (RFC 4291), and `::1` and `::` are exact-matched above.
  if (normalized.startsWith('::')) {
    const tail = normalized.slice(2);
    return tail.includes('.') ? isPrivateIPv4(tail) : true;
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
  // Check if it's IPv4. Deliberately `\d+` rather than `\d{1,3}`: a non-canonical octet like the
  // `0177` in `0177.0.0.1` is four digits, so a `\d{1,3}` gate here would route an ambiguous IPv4
  // literal into the IPv6 branch, which returns false for it. `isPrivateIPv4` is what decides whether
  // the form is acceptable; this only decides which family to hand it to.
  if (/^(\d+\.){3}\d+$/.test(ip)) {
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
  // Brackets stripped FIRST: every comparison below is against an unbracketed form, so `[::1]` used
  // to match none of them and be reported as safe.
  const normalized = stripIpv6Brackets(hostname);

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

  // Block AWS metadata endpoint (critical for Lambda security)
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

  // Check if it's an IP address in private ranges. `\d+` not `\d{1,3}` for the same reason as in
  // `isPrivateIP`: a non-canonical octet can be longer than three digits, and this gate decides only
  // which family to dispatch to, never whether the literal is acceptable.
  if (/^(\d+\.){3}\d+$/.test(normalized)) {
    return isPrivateIPv4(normalized);
  }

  // Check if it's an IPv6 address
  if (normalized.includes(':')) {
    return isPrivateIPv6(normalized);
  }

  return false;
}

/**
 * Validate a URL before fetching.
 * Blocks internal/private networks to prevent SSRF attacks.
 * Resolves DNS and validates resolved IPs to prevent DNS rebinding attacks.
 *
 * @param url - The URL to validate
 * @returns Object with valid flag and optional error message
 */
export async function validateUrlForFetch(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = new URL(url);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    // Unbracketed once, then used for BOTH decisions below. Keeping `parsed.hostname` here was the
    // bug: a bracketed IPv6 literal failed the private check AND still counted as an IP for the
    // DNS-skip, so `http://[::1]/` and `http://[::ffff:169.254.169.254]/` fell through as valid.
    const hostname = stripIpv6Brackets(parsed.hostname);

    // First check hostname directly (catches localhost, explicit IPs, etc.)
    if (isPrivateOrInternalHostname(hostname)) {
      return { valid: false, error: 'URL points to a private or internal network' };
    }

    // For non-IP hostnames, resolve DNS and validate all resolved IPs
    // This prevents DNS rebinding attacks where hostname resolves to private IP
    // `\d+`, matching the dispatch gates in `isPrivateIP` and `isPrivateOrInternalHostname`. A
    // non-canonical literal like `0177.0.0.1` is already refused by the check above, so this is
    // consistency rather than a second line of defence - but three gates that disagree about what
    // counts as IPv4 is how the bracketed-IPv6 hole happened, so they are kept identical on purpose.
    const isIPv4Address = /^(\d+\.){3}\d+$/.test(hostname);
    const isIPv6Address = hostname.includes(':');

    if (!isIPv4Address && !isIPv6Address) {
      try {
        // Try to resolve IPv4 addresses
        const ipv4Addresses = await dnsResolve4(hostname).catch(() => [] as string[]);

        // Try to resolve IPv6 addresses
        const ipv6Addresses = await dnsResolve6(hostname).catch(() => [] as string[]);

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

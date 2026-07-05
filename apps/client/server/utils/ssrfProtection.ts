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

/**
 * Check if an IPv6 address is in a private/internal range.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

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

  // ::ffff:0:0/96 - IPv4-mapped IPv6 addresses (check the embedded IPv4)
  const ipv4MappedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedMatch) {
    return isPrivateIPv4(ipv4MappedMatch[1]);
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
  const normalized = hostname.toLowerCase();

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
 * TOCTOU assumption: DNS is resolved here, then Node resolves independently in fetch().
 * A DNS rebinding attack could serve different IPs on the two lookups. In practice this
 * requires compromising the authoritative DNS of the target domain - acceptable risk for
 * first-party API endpoints (googleapis.com, linkedin.com) but worth noting for future
 * callers that add untrusted user-supplied URLs.
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

/**
 * Synchronous URL validation for cases where DNS resolution is not needed
 * (e.g., the URL has already been validated or is known to be safe).
 *
 * @param url - The URL to validate
 * @returns Object with valid flag and optional error message
 */
export function validateTargetUrlSync(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    // Check hostname directly
    if (isPrivateOrInternalHostname(parsed.hostname)) {
      return { valid: false, error: 'URL points to a private or internal network' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

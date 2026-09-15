/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Provides validation functions to prevent SSRF attacks by blocking
 * requests to internal/private networks, cloud metadata endpoints,
 * and other sensitive destinations.
 *
 * Used by webhook delivery and test endpoints.
 *
 * `isPrivateIP` and `isPrivateOrInternalHostname` are re-exported from `@bike4mind/fab-pipeline`
 * rather than reimplemented here - this file used to carry its own per-hextet IPv6 prefix list that
 * drifted out of sync with the hardened one there (#1969).
 */

import { isPrivateIP, isPrivateOrInternalHostname } from '@bike4mind/fab-pipeline';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

export { isPrivateIP, isPrivateOrInternalHostname };

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

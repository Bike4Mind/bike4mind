/**
 * SSRF guard for server-side fetches to caller/user-influenced URLs. Returns null if the URL
 * is safe to fetch, otherwise a human-readable reason. Shared so every server-side fetch of an
 * externally-supplied host (image proxy, blog presign, ...) applies the same rules - adding a
 * new outbound surface should import this rather than re-derive the IP ranges.
 *
 * Note: this is a hostname-string check, not a DNS-resolved IP check, so it does not defend
 * against DNS rebinding. Pair it with an auth/ownership gate as the primary control; this is
 * defense in depth (cloud metadata, loopback, internal services).
 */
export function rejectIfUnsafe(url: URL): string | null {
  if (url.protocol !== 'https:') {
    return 'only https URLs are allowed';
  }

  // Normalize: strip square brackets from IPv6 notation so the same checks
  // work for both `::1` and `[::1]` forms returned by URL.hostname.
  const raw = url.hostname.toLowerCase();
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;

  // Reject literal loopback / unspecified
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return 'loopback hosts are not allowed';
  }

  // Reject IPv4-mapped IPv6 addresses (::ffff:a.b.c.d / ::ffff:hex:hex).
  // Node normalises these to ::ffff:XXYY:ZZWW which bypasses the IPv4 regex but
  // fetch() still dials the underlying IPv4 address.
  if (host.includes('ffff:')) {
    return 'IPv4-mapped IPv6 addresses are not allowed';
  }

  // Reject IPv4 in private / loopback / link-local ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) || // link-local + AWS metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / reserved
    ) {
      return 'private/reserved IPv4 addresses are not allowed';
    }
  }

  // Reject IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return 'private/reserved IPv6 addresses are not allowed';
  }

  return null;
}

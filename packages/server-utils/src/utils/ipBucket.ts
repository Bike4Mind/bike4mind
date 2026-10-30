import { ipv6Slash64 } from './ipv6Slash64';

/**
 * The per-IP limit subject. IPv6 is bucketed by /64, the smallest prefix a single subscriber is
 * usually assigned, so one holder cannot rotate through addresses for a fresh budget. IPv4 and
 * IPv4-mapped IPv6 are keyed on the full address. Anything unparseable is returned unchanged.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const address = ip.split('%')[0];
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mappedV4) return mappedV4[1];
  return ipv6Slash64(address) ?? ip;
}

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

  const halves = address.split('::');
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return ip;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map(g => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

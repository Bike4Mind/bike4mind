/**
 * The /64 prefix of an IPv6 address, written canonically (`2001:db8:aa:1::/64`), or null when the
 * address does not parse. Zone IDs must already be stripped. Shared by the OTC per-IP limit
 * (otcLimits.ts) and the sharedNetwork signup signal (signupClassifier.ts) so both bucket alike.
 */
export function ipv6Slash64(address: string): string | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return `${groups
    .slice(0, 4)
    .map(group => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

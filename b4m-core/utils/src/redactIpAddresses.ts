/**
 * Replaces IPv4 and IPv6 addresses in free text with `[IP]`. Used on log text bound for Slack:
 * CloudWatch keeps the full address, the error channel does not (`errorLogSlackMessage.ts`).
 *
 * Both patterns are anchored so they do not fire inside longer tokens: `1.2.3.4.5`, `v1.2.3.4`,
 * `10:00:00` timestamps, MAC addresses and `Foo::bar` paths are left alone. A bare four-part
 * version string such as `1.2.3.4` is scrubbed; that costs nothing in an error card.
 */

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?!\\.?\\w)`, 'g');

const HEX_GROUP = '[0-9a-f]{1,4}';
const HEX_RUN = `${HEX_GROUP}(?::${HEX_GROUP}){0,6}`;
// Full eight-group form, or one `::` with at least one group on either side. Runs after IPv4, so an
// IPv4-mapped address (`::ffff:192.0.2.1`) arrives as `::ffff:[IP]` and the tail is taken with it.
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${HEX_GROUP}:){7}${HEX_GROUP}|${HEX_RUN}::(?:${HEX_RUN})?|::${HEX_RUN})(?::\\[IP\\])?(?![\\w:])`,
  'gi'
);

export const REDACTED_IP = '[IP]';

export function redactIpAddresses(text: string): string {
  return text.replace(IPV4, REDACTED_IP).replace(IPV6, REDACTED_IP);
}

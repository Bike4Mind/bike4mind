import type { INetworkMeta } from '@bike4mind/common';

/**
 * Hosting/cloud ASNs whose traffic is servers, not people: a signup from one is a weak abuse
 * signal (scripted signups), never a block on its own. Kept short and high-precision on purpose -
 * an ASN that also carries consumer traffic (ISPs, mobile carriers, consumer VPN apps) does not
 * belong here, since a wrong entry marks real people. Keyed by ASN; the value is the operator.
 */
export const DATACENTER_ASNS: ReadonlyMap<number, string> = new Map([
  [16509, 'Amazon AWS'],
  [14618, 'Amazon AWS'],
  [8987, 'Amazon AWS'],
  [15169, 'Google'],
  [396982, 'Google Cloud'],
  [8075, 'Microsoft Azure'],
  [31898, 'Oracle Cloud'],
  [14061, 'DigitalOcean'],
  [63949, 'Akamai Linode'],
  [20473, 'Vultr'],
  [16276, 'OVH'],
  [24940, 'Hetzner'],
  [213230, 'Hetzner Cloud'],
  [51167, 'Contabo'],
  [12876, 'Scaleway'],
  [45102, 'Alibaba Cloud'],
  [132203, 'Tencent Cloud'],
  [36352, 'ColoCrossing'],
  [53667, 'FranTech'],
]);

/**
 * Whether a request came from a hosting/VPN network: a datacenter ASN or a WAF anonymous-IP label.
 * Null when neither signal was available, so "not checked" is never read as "clean".
 */
export function hostingNetworkOf(network: Pick<INetworkMeta, 'isDatacenter' | 'wafAnonIp'>): boolean | null {
  const flags = [network.isDatacenter, network.wafAnonIp ?? null];
  return flags.includes(true) ? true : flags.includes(false) ? false : null;
}

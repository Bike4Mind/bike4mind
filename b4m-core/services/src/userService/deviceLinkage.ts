/**
 * Ban-evasion device linkage: whether a new account was used from the same client device as an
 * account that is already banned (an admin Suspend or Contain sets isBanned). Pure and
 * deterministic, so the rule is tested without a database; the server side
 * (apps/client/server/security/autoContainment/deviceLink.ts) loads the rows and records the result
 * as a `deviceLinkedToBlocked` shadow detection.
 *
 * A device is the exact (screen size, pixel ratio, user agent) triple a sign-in records
 * (ILoginRecord). The IP is deliberately not part of it: a VPN rotates the IP, the device stays.
 *
 * Like the account campaign sweep (accountCampaigns.ts), a shared value is never evidence on its own:
 * - A mainstream device profile (one phone model on one browser build) is shared by unrelated people,
 *   so a profile seen on signups from DEVICE_LINK_POLICY.commonDeviceMinNetworks or more distinct
 *   networks over the baseline is ignored. Spread across networks, not an account count, is the test,
 *   so a farm that makes many accounts on one or two networks cannot make its own device look common.
 * - A match on an uncommon device still needs minCorroboratingAxes independent corroborating axes:
 *   the same uncommon JA4, the same signup network, or signups close in time.
 */

export type DeviceRecord = {
  screenResolution?: string | null;
  devicePixelRatio?: number | null;
  userAgent?: string | null;
};

export type DeviceLinkAccount = {
  userId: string;
  signedUpAt: Date | null;
  /** Normalized device keys (deviceKey) from the account's sign-in records. */
  deviceKeys: readonly string[];
  /** Signup IPv4 /24 or IPv6 /48 prefix. */
  networkPrefix: string | null;
  asn: number | null;
  /** Whether the signup ASN is a hosting network (VPN exits, cloud). Null when unknown. */
  hosting: boolean | null;
  /** Signup JA4. */
  fingerprint: string | null;
};

export const DEVICE_LINK_AXES = ['fingerprint', 'network', 'timing'] as const;
export type DeviceLinkAxis = (typeof DEVICE_LINK_AXES)[number];

export type DeviceLinkPolicy = {
  /** A device seen on signups from this many distinct networks (ASNs) over the baseline is mainstream. */
  commonDeviceMinNetworks: number;
  /** Signups at most this many hours apart corroborate a device match. */
  timingWindowHours: number;
  /** Corroborating axes required on top of the shared device. */
  minCorroboratingAxes: number;
};

export const DEFAULT_DEVICE_LINK_POLICY: DeviceLinkPolicy = {
  commonDeviceMinNetworks: 5,
  timingWindowHours: 168,
  minCorroboratingAxes: 1,
};

export type BanEvasionMatch = {
  blockedUserId: string;
  /** The axes besides the device that agree, in DEVICE_LINK_AXES order. */
  corroboration: DeviceLinkAxis[];
  /** Hours between the two signups; null when either signup time is unknown. */
  hoursApart: number | null;
};

export type BanEvasionResult =
  | { linked: false; reason: 'no_device' | 'no_blocked_device_match' | 'common_device_only' | 'uncorroborated' }
  | {
      linked: true;
      /** Strongest first: most corroborating axes, then the closest signup. */
      matches: BanEvasionMatch[];
      /** How many networks the matched devices were seen on over the baseline (the largest). */
      deviceNetworkSpread: number;
    };

const SCREEN_PATTERN = /^\d{2,5}x\d{2,5}$/;
// Shorter strings are placeholders or truncated headers, not a browser build.
const MIN_USER_AGENT_LENGTH = 20;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The normalized device key of one sign-in, or null when any part is missing or a placeholder
 * (the sign-in path stores 'Unknown' for a missing screen size).
 */
export function deviceKey(record: DeviceRecord): string | null {
  const screen = record.screenResolution?.trim().toLowerCase() ?? '';
  const userAgent = record.userAgent?.trim().replace(/\s+/g, ' ') ?? '';
  const ratio = record.devicePixelRatio;
  if (!SCREEN_PATTERN.test(screen) || userAgent.length < MIN_USER_AGENT_LENGTH) return null;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return null;
  return `${screen}|${Math.round(ratio * 100) / 100}|${userAgent}`;
}

/** The distinct device keys of a set of sign-in records, in first-seen order. */
export function deviceKeysOf(records: readonly DeviceRecord[]): string[] {
  return [...new Set(records.map(deviceKey).filter((key): key is string => key !== null))];
}

/**
 * Distinct signup networks per device key over a baseline of accounts. A network is the ASN, or the
 * signup prefix when the ASN is unknown; accounts with neither add nothing.
 */
export function deviceNetworkSpread(
  accounts: readonly Pick<DeviceLinkAccount, 'deviceKeys' | 'asn' | 'networkPrefix'>[]
): Map<string, number> {
  const networks = new Map<string, Set<string>>();
  for (const account of accounts) {
    const network =
      account.asn !== null ? `asn:${account.asn}` : account.networkPrefix ? `prefix:${account.networkPrefix}` : null;
    if (!network) continue;
    for (const key of account.deviceKeys) networks.set(key, (networks.get(key) ?? new Set<string>()).add(network));
  }
  return new Map([...networks].map(([key, set]) => [key, set.size]));
}

function hoursApart(a: Date | null, b: Date | null): number | null {
  return a && b ? Math.round(Math.abs(a.getTime() - b.getTime()) / HOUR_MS) : null;
}

function corroboratingAxes(
  account: DeviceLinkAccount,
  blocked: DeviceLinkAccount,
  commonFingerprints: ReadonlySet<string>,
  policy: DeviceLinkPolicy
): DeviceLinkAxis[] {
  const axes: DeviceLinkAxis[] = [];
  if (
    account.fingerprint &&
    account.fingerprint === blocked.fingerprint &&
    !commonFingerprints.has(account.fingerprint)
  ) {
    axes.push('fingerprint');
  }
  const samePrefix = account.networkPrefix !== null && account.networkPrefix === blocked.networkPrefix;
  // A shared hosting ASN is a VPN or cloud exit that strangers share; only a residential or mobile ASN counts.
  const sameAsn = account.asn !== null && account.asn === blocked.asn && account.hosting === false;
  if (samePrefix || sameAsn) axes.push('network');
  const hours = hoursApart(account.signedUpAt, blocked.signedUpAt);
  if (hours !== null && hours <= policy.timingWindowHours) axes.push('timing');
  return axes;
}

/**
 * Applies the rule to one account. `blocked` are banned accounts (the account itself is skipped),
 * `networkSpread` comes from deviceNetworkSpread over the baseline, `commonFingerprints` are JA4s
 * the campaign sweep treats as mainstream.
 */
export function findBanEvasionLinks(input: {
  account: DeviceLinkAccount;
  blocked: readonly DeviceLinkAccount[];
  networkSpread: ReadonlyMap<string, number>;
  commonFingerprints: ReadonlySet<string>;
  policy?: DeviceLinkPolicy;
}): BanEvasionResult {
  const policy = input.policy ?? DEFAULT_DEVICE_LINK_POLICY;
  const { account } = input;
  if (account.deviceKeys.length === 0) return { linked: false, reason: 'no_device' };

  const shared = (other: DeviceLinkAccount) => account.deviceKeys.filter(key => other.deviceKeys.includes(key));
  const sharing = input.blocked
    .filter(other => other.userId !== account.userId)
    .map(other => ({ other, keys: shared(other) }))
    .filter(({ keys }) => keys.length > 0);
  if (sharing.length === 0) return { linked: false, reason: 'no_blocked_device_match' };

  const isUncommon = (key: string) => (input.networkSpread.get(key) ?? 0) < policy.commonDeviceMinNetworks;
  const uncommon = sharing.filter(({ keys }) => keys.some(isUncommon));
  if (uncommon.length === 0) return { linked: false, reason: 'common_device_only' };

  const matches = uncommon
    .map(({ other }) => ({
      blockedUserId: other.userId,
      corroboration: corroboratingAxes(account, other, input.commonFingerprints, policy),
      hoursApart: hoursApart(account.signedUpAt, other.signedUpAt),
    }))
    .filter(match => match.corroboration.length >= policy.minCorroboratingAxes)
    .sort(
      (a, b) =>
        b.corroboration.length - a.corroboration.length ||
        (a.hoursApart ?? Infinity) - (b.hoursApart ?? Infinity) ||
        a.blockedUserId.localeCompare(b.blockedUserId)
    );
  if (matches.length === 0) return { linked: false, reason: 'uncorroborated' };

  const matchedKeys = uncommon.flatMap(({ keys }) => keys.filter(isUncommon));
  return {
    linked: true,
    matches,
    deviceNetworkSpread: Math.max(0, ...matchedKeys.map(key => input.networkSpread.get(key) ?? 0)),
  };
}

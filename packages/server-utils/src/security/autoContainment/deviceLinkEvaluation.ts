import type { DeviceLinkRow } from '@bike4mind/database';
import {
  countSignupsWithFingerprint,
  findBannedDeviceLinkAccounts,
  findDeviceBaselineAccounts,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { truncateIp } from '../../utils/ip';
import { hostingNetworkOf } from '../../auth/datacenterAsns';

/**
 * The read side of the ban-evasion device rule: loads the banned accounts and the baseline a set of
 * accounts is compared with, and applies the engine (b4m-core/services/src/userService/deviceLinkage.ts).
 * Read-only. Used by the rule itself (deviceLink.ts) and by the assessment's linked-account evidence
 * (abuseAssessment/linkedAccountEvidence.ts).
 */

const HOUR_MS = 60 * 60 * 1000;
const BASELINE_DAYS = 30;
const BASELINE_LIMIT = 2_000;
const BANNED_LIMIT = 500;
// The $in list a single query carries; larger sets are queried in chunks.
const USER_AGENT_CHUNK = 50;
// Single-user-agent re-reads allowed per evaluation after a truncated chunk; the rest fail closed.
const MAX_SINGLE_AGENT_READS = 10;
// Same thresholds as the account campaign sweep's common-JA4 guard (cron/accountCampaignSweep.ts).
const COMMON_FINGERPRINT_MIN_SIGNUPS = 50;

export type DeviceLinkConfig = { windowHours: number; commonNetworks: number };

export const DEFAULT_DEVICE_LINK_CONFIG: DeviceLinkConfig = {
  windowHours: userService.DEFAULT_DEVICE_LINK_POLICY.timingWindowHours,
  commonNetworks: userService.DEFAULT_DEVICE_LINK_POLICY.commonDeviceMinNetworks,
};

export type DeviceLinkReaders = {
  findBanned: (userAgents: string[]) => Promise<DeviceLinkRow[]>;
  findBaseline: (userAgents: string[], since: Date) => Promise<{ rows: DeviceLinkRow[]; truncated: boolean }>;
  isCommonFingerprint: (ja4: string) => Promise<boolean>;
  now: () => Date;
};

export const liveDeviceLinkReaders: DeviceLinkReaders = {
  findBanned: userAgents => findBannedDeviceLinkAccounts({ userAgents, limit: BANNED_LIMIT }),
  findBaseline: (userAgents, since) => findDeviceBaselineAccounts({ userAgents, since, limit: BASELINE_LIMIT }),
  isCommonFingerprint: async ja4 =>
    (await countSignupsWithFingerprint({ ja4, since: new Date(Date.now() - BASELINE_DAYS * 24 * HOUR_MS) })) >=
    COMMON_FINGERPRINT_MIN_SIGNUPS,
  now: () => new Date(),
};

export function toDeviceLinkAccount(row: DeviceLinkRow): userService.DeviceLinkAccount {
  return {
    userId: row.userId,
    signedUpAt: row.createdAt,
    deviceKeys: userService.deviceKeysOf(row.devices),
    networkPrefix: row.signupIp ? truncateIp(row.signupIp) : null,
    asn: row.asn,
    hosting: hostingNetworkOf({ isDatacenter: row.isDatacenter, wafAnonIp: row.wafAnonIp }),
    fingerprint: row.ja4,
  };
}

const userAgentsOf = (rows: readonly DeviceLinkRow[]) => [
  ...new Set(rows.flatMap(row => row.devices.map(device => device.userAgent?.trim() ?? '').filter(Boolean))),
];

async function inChunks(values: string[], read: (chunk: string[]) => Promise<DeviceLinkRow[]>) {
  const rows: DeviceLinkRow[] = [];
  for (let start = 0; start < values.length; start += USER_AGENT_CHUNK) {
    rows.push(...(await read(values.slice(start, start + USER_AGENT_CHUNK))));
  }
  return uniqueById(rows);
}

const uniqueById = (rows: readonly DeviceLinkRow[]) => [...new Map(rows.map(row => [row.userId, row])).values()];

// Matches the user-agent part of userService.deviceKey, which is `screen|ratio|userAgent`.
const normalizeUserAgent = (userAgent: string) => userAgent.trim().replace(/\s+/g, ' ');
const userAgentOfKey = (key: string) => key.split('|').slice(2).join('|');

/**
 * The baseline for the matched user agents, plus the user agents whose spread it could not measure.
 * A capped read returns only the newest rows across its whole $in list, so one mainstream user agent
 * can crowd out the rest; a truncated chunk is re-read one user agent at a time, and a user agent
 * still truncated (or past MAX_SINGLE_AGENT_READS) is reported as unmeasured so the caller treats it
 * as common. Truncation can only cause a missed link, never a false one.
 */
async function readBaseline(userAgents: string[], since: Date, deps: DeviceLinkReaders) {
  const rows: DeviceLinkRow[] = [];
  const unmeasured = new Set<string>();
  let singleReads = 0;
  for (let start = 0; start < userAgents.length; start += USER_AGENT_CHUNK) {
    const chunk = userAgents.slice(start, start + USER_AGENT_CHUNK);
    const read = await deps.findBaseline(chunk, since);
    if (!read.truncated || chunk.length === 1) {
      rows.push(...read.rows);
      if (read.truncated) unmeasured.add(normalizeUserAgent(chunk[0]));
      continue;
    }
    for (const userAgent of chunk) {
      if (singleReads >= MAX_SINGLE_AGENT_READS) {
        unmeasured.add(normalizeUserAgent(userAgent));
        continue;
      }
      singleReads += 1;
      const single = await deps.findBaseline([userAgent], since);
      rows.push(...single.rows);
      if (single.truncated) unmeasured.add(normalizeUserAgent(userAgent));
    }
  }
  return { rows: uniqueById(rows), unmeasured };
}

/**
 * Evaluates the rule for each account against the banned accounts sharing a user agent with any of
 * them. Read-only. Accounts with no usable device come back unlinked.
 */
export async function evaluateDeviceLinks(
  rows: readonly DeviceLinkRow[],
  config: DeviceLinkConfig,
  deps: DeviceLinkReaders
): Promise<Map<string, userService.BanEvasionResult>> {
  const accounts = rows.map(toDeviceLinkAccount);
  const results = new Map<string, userService.BanEvasionResult>();
  const withDevice = accounts.filter(account => account.deviceKeys.length > 0);
  accounts
    .filter(account => account.deviceKeys.length === 0)
    .forEach(account => results.set(account.userId, { linked: false, reason: 'no_device' }));
  if (withDevice.length === 0) return results;

  const candidateRows = rows.filter(row => withDevice.some(account => account.userId === row.userId));
  const banned = (await inChunks(userAgentsOf(candidateRows), deps.findBanned)).map(toDeviceLinkAccount);
  const bannedKeys = new Set(banned.flatMap(account => account.deviceKeys));
  const sharedKeys = new Set(withDevice.flatMap(account => account.deviceKeys.filter(key => bannedKeys.has(key))));

  // The baseline is read only for user agents that matched a banned account, which is rare.
  const matchedUserAgents = [
    ...new Set(
      candidateRows.flatMap(row =>
        row.devices.flatMap(device => {
          const key = userService.deviceKey(device);
          return key && sharedKeys.has(key) && device.userAgent ? [device.userAgent.trim()] : [];
        })
      )
    ),
  ];
  const since = new Date(deps.now().getTime() - BASELINE_DAYS * 24 * HOUR_MS);
  const baseline =
    matchedUserAgents.length > 0
      ? await readBaseline(matchedUserAgents, since, deps)
      : { rows: [], unmeasured: new Set<string>() };
  const networkSpread = userService.deviceNetworkSpread(baseline.rows.map(toDeviceLinkAccount));
  for (const key of sharedKeys) {
    if (baseline.unmeasured.has(userAgentOfKey(key))) {
      networkSpread.set(key, Math.max(networkSpread.get(key) ?? 0, config.commonNetworks));
    }
  }

  const fingerprints = [
    ...new Set(
      banned.flatMap(other =>
        withDevice.flatMap(account =>
          account.fingerprint && account.fingerprint === other.fingerprint ? [account.fingerprint] : []
        )
      )
    ),
  ];
  const commonFingerprints = new Set<string>();
  for (const ja4 of fingerprints) if (await deps.isCommonFingerprint(ja4)) commonFingerprints.add(ja4);

  const policy: userService.DeviceLinkPolicy = {
    ...userService.DEFAULT_DEVICE_LINK_POLICY,
    commonDeviceMinNetworks: config.commonNetworks,
    timingWindowHours: config.windowHours,
  };
  for (const account of withDevice) {
    results.set(
      account.userId,
      userService.findBanEvasionLinks({ account, blocked: banned, networkSpread, commonFingerprints, policy })
    );
  }
  return results;
}

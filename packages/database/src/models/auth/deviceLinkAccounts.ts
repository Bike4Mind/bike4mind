import { z } from 'zod';
import { User } from './UserModel';

/**
 * The raw per-account rows the ban-evasion device linkage reads (engine:
 * b4m-core/services/src/userService/deviceLinkage.ts): the device parts of the account's sign-in
 * records (loginRecords, newest 15) and its signup network. No IPs from sign-ins, no email.
 */
export type DeviceLinkRow = {
  userId: string;
  createdAt: Date | null;
  signupIp: string | null;
  asn: number | null;
  isDatacenter: boolean | null;
  ja4: string | null;
  isBanned?: boolean;
  devices: { screenResolution: string | null; devicePixelRatio: number | null; userAgent: string | null }[];
};

const MAX_TIME_MS = 20_000;
const MAX_USER_AGENTS = 50;

type LeanDeviceUser = {
  _id: { toString(): string };
  createdAt?: Date | null;
  isBanned?: boolean | null;
  signupMeta?: { ip?: string | null; asn?: number | null; isDatacenter?: boolean | null; ja4?: string | null } | null;
  loginRecords?: { screenResolution?: string | null; devicePixelRatio?: number | null; userAgent?: string | null }[];
};

const PROJECTION = {
  createdAt: 1,
  isBanned: 1,
  'signupMeta.ip': 1,
  'signupMeta.asn': 1,
  'signupMeta.isDatacenter': 1,
  'signupMeta.ja4': 1,
  'loginRecords.screenResolution': 1,
  'loginRecords.devicePixelRatio': 1,
  'loginRecords.userAgent': 1,
} as const;

function toRow(user: LeanDeviceUser): DeviceLinkRow {
  return {
    userId: user._id.toString(),
    createdAt: user.createdAt ?? null,
    signupIp: user.signupMeta?.ip ?? null,
    asn: user.signupMeta?.asn ?? null,
    isDatacenter: user.signupMeta?.isDatacenter ?? null,
    ja4: user.signupMeta?.ja4 ?? null,
    isBanned: user.isBanned === true,
    devices: (user.loginRecords ?? []).map(record => ({
      screenResolution: record.screenResolution ?? null,
      devicePixelRatio: record.devicePixelRatio ?? null,
      userAgent: record.userAgent ?? null,
    })),
  };
}

const userAgentsSchema = z.array(z.string().min(1)).min(1).max(MAX_USER_AGENTS);

/** The given accounts; unknown or deleted ids are absent. */
export async function loadDeviceLinkAccounts(userIds: readonly string[]): Promise<DeviceLinkRow[]> {
  if (userIds.length === 0) return [];
  const users = await User.find({ _id: { $in: userIds }, deletedAt: null }, PROJECTION)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDeviceUser[]>()
    .exec();
  return users.map(toRow);
}

/**
 * Live, unbanned accounts created in [since, until) that have at least one sign-in record, newest
 * first, capped at `limit`. Served by the createdAt index.
 */
export async function loadRecentDeviceLinkAccounts(input: {
  since: Date;
  until: Date;
  limit: number;
}): Promise<{ rows: DeviceLinkRow[]; truncated: boolean }> {
  const users = await User.find(
    {
      createdAt: { $gte: input.since, $lt: input.until },
      deletedAt: null,
      isBanned: { $ne: true },
      'loginRecords.0': { $exists: true },
    },
    PROJECTION
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(input.limit + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDeviceUser[]>()
    .exec();
  return { rows: users.slice(0, input.limit).map(toRow), truncated: users.length > input.limit };
}

/**
 * Banned accounts (admin Suspend and Contain both set isBanned) with a sign-in from any of the given
 * user agents, newest first. Served by the user_isBanned_true partial index; the user agent is
 * filtered among banned accounts only.
 */
export async function findBannedDeviceLinkAccounts(input: {
  userAgents: readonly string[];
  limit: number;
}): Promise<DeviceLinkRow[]> {
  const userAgents = userAgentsSchema.parse([...new Set(input.userAgents)].slice(0, MAX_USER_AGENTS));
  const users = await User.find(
    { isBanned: true, deletedAt: null, 'loginRecords.userAgent': { $in: userAgents } },
    PROJECTION
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(input.limit)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDeviceUser[]>()
    .exec();
  return users.map(toRow);
}

/**
 * Accounts created since `since` with a sign-in from any of the given user agents: the baseline the
 * common-device guard measures a device's spread over. Served by the createdAt index.
 */
export async function findDeviceBaselineAccounts(input: {
  userAgents: readonly string[];
  since: Date;
  limit: number;
}): Promise<DeviceLinkRow[]> {
  const userAgents = userAgentsSchema.parse([...new Set(input.userAgents)].slice(0, MAX_USER_AGENTS));
  const users = await User.find(
    { createdAt: { $gte: input.since }, 'loginRecords.userAgent': { $in: userAgents } },
    PROJECTION
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(input.limit)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanDeviceUser[]>()
    .exec();
  return users.map(toRow);
}

/** Signups since `since` with this JA4; served by user_signup_fingerprint_window. */
export async function countSignupsWithFingerprint(input: { ja4: string; since: Date }): Promise<number> {
  return User.countDocuments({ createdAt: { $gte: input.since }, 'signupMeta.ja4': input.ja4 })
    .maxTimeMS(MAX_TIME_MS)
    .exec();
}

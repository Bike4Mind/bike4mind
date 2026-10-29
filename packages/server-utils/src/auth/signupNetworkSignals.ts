import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { type INetworkMeta, type IUserDocument } from '@bike4mind/common';
import { authEventRepository, signupTraceRepository } from '@bike4mind/database';
import type { userService } from '@bike4mind/services';
import { Config } from '../utils/config';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A bigger result set is reported as unknown (null), never as a low count. The limit settings'
// max (settings.ts) must stay at or below this; the gate treats a truncated count as over.
export const MAX_COUNTED_ROWS = 5_000;
// recentDistinctSignups refuses windows reaching past the AuthEvent TTL (90 days); an anchor older
// than this would put the 24h window (plus a day of slack) outside it.
const OLDEST_ANCHOR_MS = 88 * DAY_MS;

/** The windows the risk policy's `ipSignups`/`prefixSignups` (24h) and `asnSignups` (1h) count over. */
export const SIGNUP_NETWORK_WINDOWS = { ipMs: DAY_MS, asnMs: HOUR_MS } as const;

export type SignupNetwork = Pick<INetworkMeta, 'ip' | 'asn' | 'isDatacenter'>;
type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

type SignupCounts = { ipSignups: number | null; prefixSignups: number | null; asnSignups: number | null };

// Its own key, derived from the JWT secret, so no trace hash is ever computed under the signing key.
// Memoized lazily (Config is not read at import). Rotating JWT_SECRET orphans existing traces, so
// the counts under-count until their 2-day TTL drops them.
let cachedTraceKey: Buffer | undefined;
const traceKey = () => (cachedTraceKey ??= createHmac('sha256', Config.JWT_SECRET).update('signup-trace/v1').digest());
const traceHash = (value: string) => createHmac('sha256', traceKey()).update(value).digest('hex');

/** The SignupTrace keys for an IP: exact address, plus the /24 for IPv4 (as recentDistinctSignups counts it). */
export function hashSignupNetwork(ip: string | null): { ipHash: string | null; prefixHash: string | null } {
  const version = ip === null ? 0 : isIP(ip);
  if (!ip || !version) return { ipHash: null, prefixHash: null };
  const prefix = version === 4 ? ip.slice(0, ip.lastIndexOf('.') + 1) : null;
  return { ipHash: traceHash(`ip:${ip}`), prefixHash: prefix ? traceHash(`prefix:${prefix}`) : null };
}

/**
 * Before an account's AuthEvent rows are purged, keep its signups from the last 24h (the longest
 * count window) as hashed SignupTraces, so deleting accounts does not reset the network counts.
 * Throws on failure; the caller decides whether that blocks the purge.
 */
export async function retainDeletedSignupTraces(userId: string): Promise<number> {
  const signups = await authEventRepository.findSignupsSince(
    userId,
    new Date(Date.now() - SIGNUP_NETWORK_WINDOWS.ipMs)
  );
  const accountHash = traceHash(`account:${userId}`);
  await signupTraceRepository.retain(
    signups.map(signup => ({
      accountHash,
      signedUpAt: signup.createdAt,
      asn: signup.asn,
      ...hashSignupNetwork(signup.ip),
    }))
  );
  return signups.length;
}

// Live accounts (AuthEvent) plus deleted ones (SignupTrace). Both are asked under the same
// conditions, so a null from either is a truncated scan or a count nobody asked for: null overall.
const addCounts = (live: number | null, deleted: number | null) =>
  live === null || deleted === null ? null : live + deleted;

// The 24h window scans only ip (plus /24 when asked) and the 1h window only ASN, and a caller skips
// any window or /24 count it would not read, so no scan runs whose count is thrown away.
export async function countRecentSignups(input: {
  network: SignupNetwork;
  userId?: string;
  at: Date;
  windows: { ip: boolean; prefix: boolean; asn: boolean };
  // When set, a failed trace count is logged and skipped (live signups only) instead of thrown.
  traceFallback?: WarnLogger;
}): Promise<SignupCounts> {
  const { network, userId, at, windows, traceFallback } = input;
  const hashes = hashSignupNetwork(network.ip);
  const scan = async (ms: number, scope: { ip: string | null; asn: number | null; prefix?: boolean }) => {
    const since = new Date(at.getTime() - ms);
    const [live, deleted] = await Promise.all([
      authEventRepository.recentDistinctSignups({ userId, since, until: at, ...scope, maxRows: MAX_COUNTED_ROWS }),
      signupTraceRepository
        .recentDistinctSignups({
          since,
          until: at,
          ipHash: scope.ip === null ? null : hashes.ipHash,
          prefixHash: scope.ip === null || scope.prefix === false ? null : hashes.prefixHash,
          asn: scope.asn,
          maxRows: MAX_COUNTED_ROWS,
        })
        .catch((error: unknown): SignupCounts => {
          if (!traceFallback) throw error;
          traceFallback.warn('[signup-limits] Signup trace count failed; counting live signups only', error);
          return { ipSignups: 0, prefixSignups: 0, asnSignups: 0 };
        }),
    ]);
    return {
      ipSignups: addCounts(live.ipSignups, deleted.ipSignups),
      prefixSignups: addCounts(live.prefixSignups, deleted.prefixSignups),
      asnSignups: addCounts(live.asnSignups, deleted.asnSignups),
    };
  };
  const [day, hour] = await Promise.all([
    windows.ip ? scan(SIGNUP_NETWORK_WINDOWS.ipMs, { ip: network.ip, asn: null, prefix: windows.prefix }) : null,
    windows.asn ? scan(SIGNUP_NETWORK_WINDOWS.asnMs, { ip: null, asn: network.asn }) : null,
  ]);
  return {
    ipSignups: day?.ipSignups ?? null,
    prefixSignups: day?.prefixSignups ?? null,
    asnSignups: hour?.asnSignups ?? null,
  };
}

function recordedAnchor(capturedAt: Date | undefined): Date | null {
  if (!capturedAt) return null;
  const time = new Date(capturedAt).getTime();
  const now = Date.now();
  if (!Number.isFinite(time) || time < now - OLDEST_ANCHOR_MS) return null;
  return new Date(Math.min(time, now));
}

/**
 * The staged grant's network signals: the datacenter flag plus how many OTHER accounts signed up
 * from the same IP, IPv4 /24 and ASN shortly before this one. `network` is this request's network
 * on a live signup; without it the account's recorded signupMeta is used, anchored at its capture
 * time. No network at all leaves every signal missing, which the risk policy treats as configured;
 * a signupMeta with no capture time, or one older than AuthEvent retention, leaves the counts missing.
 */
export function createSignupRiskCollector(network?: SignupNetwork | null) {
  return async (user: IUserDocument): Promise<userService.SignupRiskSignals> => {
    const source = network ?? user.signupMeta ?? null;
    if (!source) return {};
    const at = network ? new Date() : recordedAnchor(user.signupMeta?.capturedAt);
    if (!at) return { datacenter: source.isDatacenter };
    const counts = await countRecentSignups({
      network: source,
      userId: user.id,
      at,
      windows: { ip: true, prefix: true, asn: true },
    });
    return { datacenter: source.isDatacenter, ...counts };
  };
}

import { isIP } from 'node:net';
import { type INetworkMeta, type IUserDocument, TooManyRequestsError } from '@bike4mind/common';
import { adminSettingsRepository, authEventRepository } from '@bike4mind/database';
import type { userService } from '@bike4mind/services';
import { SIGNUP_LIMITED_MESSAGE } from '@server/utils/auth/oauthFailureReason';

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

type SignupNetwork = Pick<INetworkMeta, 'ip' | 'asn' | 'isDatacenter'>;
type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

type SignupCounts = { ipSignups: number | null; prefixSignups: number | null; asnSignups: number | null };

// The 24h window scans only ip and /24 and the 1h window only ASN, and a caller that needs neither
// window skips it, so no scan runs whose count is thrown away.
async function countRecentSignups(input: {
  network: SignupNetwork;
  userId?: string;
  at: Date;
  windows: { ip: boolean; asn: boolean };
}): Promise<SignupCounts> {
  const { network, userId, at, windows } = input;
  const scan = (ms: number, scope: { ip: string | null; asn: number | null }) =>
    authEventRepository.recentDistinctSignups({
      userId,
      since: new Date(at.getTime() - ms),
      until: at,
      ...scope,
      maxRows: MAX_COUNTED_ROWS,
    });
  const [day, hour] = await Promise.all([
    windows.ip ? scan(SIGNUP_NETWORK_WINDOWS.ipMs, { ip: network.ip, asn: null }) : null,
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
      windows: { ip: true, asn: true },
    });
    return { datacenter: source.isDatacenter, ...counts };
  };
}

async function readLimit(key: 'maxSignupsPerIpPerDay' | 'maxSignupsPerAsnPerHour'): Promise<number> {
  const value = Number((await adminSettingsRepository.findBySettingName(key))?.settingValue ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Refuse a new self-serve account once its IP (24h) or ASN (1h) has reached the admin cap. Both caps
 * default to 0 (off). Fails open: a settings or count failure is logged and the signup proceeds,
 * because the staged grant still assesses the account and a refusal here locks real people out.
 * Unlike the OTC rate limits this is not skipped under E2E: the caps are off unless an operator sets
 * one, and a preview or staging stage is exactly where a tester needs to see the refusal.
 */
export async function isSignupNetworkOverLimit(network: SignupNetwork, logger: WarnLogger) {
  try {
    const [ipLimit, asnLimit] = await Promise.all([
      readLimit('maxSignupsPerIpPerDay'),
      readLimit('maxSignupsPerAsnPerHour'),
    ]);
    if (!ipLimit && !asnLimit) return false;
    const { ipSignups, asnSignups } = await countRecentSignups({
      network,
      at: new Date(),
      windows: { ip: ipLimit > 0, asn: asnLimit > 0 },
    });
    // With a usable ip/asn a null count means the scan was truncated, i.e. far over any cap.
    const overIp = ipLimit > 0 && !!network.ip && isIP(network.ip) > 0 && (ipSignups ?? Infinity) >= ipLimit;
    const overAsn = asnLimit > 0 && !!network.asn && network.asn > 0 && (asnSignups ?? Infinity) >= asnLimit;
    if (overIp || overAsn) logger.warn('[signup-limits] Refused signup', { overIp, overAsn, asn: network.asn });
    return overIp || overAsn;
  } catch (error) {
    logger.warn('[signup-limits] Limit check failed; allowing signup', error);
    return false;
  }
}

/** Throws the generic refusal for paths that surface HTTP errors (OTC). */
export async function assertSignupNetworkWithinLimits(network: SignupNetwork, logger: WarnLogger) {
  if (await isSignupNetworkOverLimit(network, logger)) throw new TooManyRequestsError(SIGNUP_LIMITED_MESSAGE);
}

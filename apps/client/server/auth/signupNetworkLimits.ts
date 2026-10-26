import type { INetworkMeta, IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository, authEventRepository } from '@bike4mind/database';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import type { userService } from '@bike4mind/services';
import { TooManyRequestsError } from '@bike4mind/utils';
import { SIGNUP_LIMITED_MESSAGE } from '@server/utils/auth/oauthFailureReason';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A bigger result set is reported as unknown (null), never as a low count. Keep the limit
// settings' max (settings.ts) at or below this so a truncated scan cannot hide a breach.
const MAX_COUNTED_ROWS = 5_000;

/** The windows the risk policy's `ipSignups`/`prefixSignups` (24h) and `asnSignups` (1h) count over. */
export const SIGNUP_NETWORK_WINDOWS = { ipMs: DAY_MS, asnMs: HOUR_MS } as const;

type SignupNetwork = Pick<INetworkMeta, 'ip' | 'asn' | 'isDatacenter'>;
type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

async function countRecentSignups(input: { network: SignupNetwork; userId?: string; at: Date }) {
  const { network, userId, at } = input;
  const window = (ms: number) =>
    authEventRepository.recentDistinctSignups({
      userId,
      since: new Date(at.getTime() - ms),
      until: at,
      ip: network.ip,
      asn: network.asn,
      maxRows: MAX_COUNTED_ROWS,
    });
  const [day, hour] = await Promise.all([window(SIGNUP_NETWORK_WINDOWS.ipMs), window(SIGNUP_NETWORK_WINDOWS.asnMs)]);
  return { ipSignups: day.ipSignups, prefixSignups: day.prefixSignups, asnSignups: hour.asnSignups };
}

/**
 * The staged grant's network signals: the datacenter flag plus how many OTHER accounts signed up
 * from the same IP, IPv4 /24 and ASN shortly before this one. `network` is this request's network
 * on a live signup; without it the account's recorded signupMeta is used, anchored at its capture
 * time. No network at all leaves every signal missing, which the risk policy treats as configured.
 */
export function createSignupRiskCollector(network?: SignupNetwork | null) {
  return async (user: IUserDocument): Promise<userService.SignupRiskSignals> => {
    const source = network ?? user.signupMeta ?? null;
    if (!source) return {};
    const capturedAt = network ? null : user.signupMeta?.capturedAt;
    const at = capturedAt ? new Date(Math.min(new Date(capturedAt).getTime(), Date.now())) : new Date();
    const counts = await countRecentSignups({ network: source, userId: user.id, at });
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
 */
export async function isSignupNetworkOverLimit(network: SignupNetwork, logger: WarnLogger) {
  if (isE2EEnabled()) return false;
  try {
    const [ipLimit, asnLimit] = await Promise.all([
      readLimit('maxSignupsPerIpPerDay'),
      readLimit('maxSignupsPerAsnPerHour'),
    ]);
    if (!ipLimit && !asnLimit) return false;
    const { ipSignups, asnSignups } = await countRecentSignups({ network, at: new Date() });
    const overIp = ipLimit > 0 && ipSignups !== null && ipSignups >= ipLimit;
    const overAsn = asnLimit > 0 && asnSignups !== null && asnSignups >= asnLimit;
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

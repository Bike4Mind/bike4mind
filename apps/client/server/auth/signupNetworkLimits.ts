import { isIP } from 'node:net';
import { TooManyRequestsError } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { countRecentSignups, type SignupNetwork } from '@bike4mind/server-utils/auth/signupNetworkSignals';
import { SIGNUP_LIMITED_MESSAGE } from '@server/utils/auth/oauthFailureReason';

export {
  createSignupRiskCollector,
  hashSignupNetwork,
  retainDeletedSignupTraces,
  SIGNUP_NETWORK_WINDOWS,
  MAX_COUNTED_ROWS,
} from '@bike4mind/server-utils/auth/signupNetworkSignals';

type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

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
      windows: { ip: ipLimit > 0, prefix: false, asn: asnLimit > 0 },
      traceFallback: logger,
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

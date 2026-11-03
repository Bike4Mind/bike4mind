import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config, isDeployedStage } from '@bike4mind/server-utils/utils/config';
import { isTurnstileSecretConfigured } from '@bike4mind/server-utils/utils/turnstile';

export type TurnstilePolicy = {
  /** True only when the toggle is on, a site key is set and the secret is provisioned. */
  active: boolean;
  failClosed: boolean;
  siteKey: string;
  secret: string;
};

export type TurnstileInactiveReason = 'secret-not-configured' | 'disabled' | 'site-key-empty';
export const TURNSTILE_INACTIVE_LOG_INTERVAL_MS = 5 * 60_000;

const logger = new Logger({ metadata: { service: 'turnstile' } });
const lastInactiveWarning = new Map<TurnstileInactiveReason, number>();

// The event name feeds the metric filter in infra/turnstileAlarms.ts, so it must stay in sync; one
// request per interval per container is enough to keep that alarm raised.
function warnPolicyInactive(reason: TurnstileInactiveReason): void {
  if (!isDeployedStage()) return;
  const now = Date.now();
  const last = lastInactiveWarning.get(reason);
  if (last !== undefined && now - last < TURNSTILE_INACTIVE_LOG_INTERVAL_MS) return;
  lastInactiveWarning.set(reason, now);
  logger.warn('turnstile-policy-inactive', { reason });
}

async function readSetting<K extends 'turnstileEnabled' | 'turnstileFailClosed' | 'turnstileSiteKey'>(key: K) {
  const row = await adminSettingsRepository.findBySettingName(key);
  // Defaults apply only to absent settings, never to an unreadable or malformed policy.
  return settingsMap[key].schema.parse(row?.settingValue);
}

/** Resolved the same way for the pre-login config the form reads and the server gate that enforces it. */
export async function getTurnstilePolicy(): Promise<TurnstilePolicy> {
  const secret = Config.TURNSTILE_SECRET_KEY;
  if (!isTurnstileSecretConfigured(secret)) {
    warnPolicyInactive('secret-not-configured');
    return { active: false, failClosed: false, siteKey: '', secret: '' };
  }
  const enabled = await readSetting('turnstileEnabled');
  if (enabled !== true) {
    warnPolicyInactive('disabled');
    return { active: false, failClosed: false, siteKey: '', secret: '' };
  }
  const [failClosed, siteKey] = await Promise.all([
    readSetting('turnstileFailClosed'),
    readSetting('turnstileSiteKey'),
  ]);
  const trimmedKey = String(siteKey ?? '').trim();
  if (trimmedKey === '') warnPolicyInactive('site-key-empty');
  return {
    active: trimmedKey !== '',
    failClosed: failClosed === true,
    siteKey: trimmedKey,
    secret,
  };
}

/** Hosts a token may be solved on: the app host plus any extra comma-separated TURNSTILE_ALLOWED_HOSTNAMES. */
export function turnstileAllowedHostnames(): string[] {
  const hosts = (process.env.TURNSTILE_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  try {
    if (process.env.APP_URL) hosts.push(new URL(process.env.APP_URL).hostname.toLowerCase());
  } catch {
    // An unparsable APP_URL just narrows the allowlist to the explicit hosts.
  }
  return hosts;
}

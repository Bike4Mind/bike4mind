import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { isTurnstileSecretConfigured } from '@bike4mind/server-utils/utils/turnstile';

export type TurnstilePolicy = {
  /** True only when the toggle is on, a site key is set and the secret is provisioned. */
  active: boolean;
  failClosed: boolean;
  siteKey: string;
  secret: string;
};

async function readSetting<K extends 'turnstileEnabled' | 'turnstileFailClosed' | 'turnstileSiteKey'>(key: K) {
  const row = await adminSettingsRepository.findBySettingName(key);
  // Defaults apply only to absent settings, never to an unreadable or malformed policy.
  return settingsMap[key].schema.parse(row?.settingValue);
}

/** Resolved the same way for the pre-login config the form reads and the server gate that enforces it. */
export async function getTurnstilePolicy(): Promise<TurnstilePolicy> {
  const secret = Config.TURNSTILE_SECRET_KEY;
  if (!isTurnstileSecretConfigured(secret)) {
    return { active: false, failClosed: false, siteKey: '', secret: '' };
  }
  const enabled = await readSetting('turnstileEnabled');
  if (enabled !== true) {
    return { active: false, failClosed: false, siteKey: '', secret: '' };
  }
  const [failClosed, siteKey] = await Promise.all([
    readSetting('turnstileFailClosed'),
    readSetting('turnstileSiteKey'),
  ]);
  const trimmedKey = String(siteKey ?? '').trim();
  return {
    active: trimmedKey !== '',
    failClosed: failClosed === true,
    siteKey: trimmedKey,
    secret,
  };
}

/**
 * The policy for challenging only the sign-in code requests past a send budget: active when the
 * secret and a site key are set but the toggle is off, since the toggle already challenges every request.
 */
export async function getTurnstileStepUpPolicy(): Promise<TurnstilePolicy> {
  const secret = Config.TURNSTILE_SECRET_KEY;
  if (!isTurnstileSecretConfigured(secret)) {
    return { active: false, failClosed: false, siteKey: '', secret: '' };
  }
  const [enabled, failClosed, siteKey] = await Promise.all([
    readSetting('turnstileEnabled'),
    readSetting('turnstileFailClosed'),
    readSetting('turnstileSiteKey'),
  ]);
  const trimmedKey = String(siteKey ?? '').trim();
  return {
    active: enabled !== true && trimmedKey !== '',
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

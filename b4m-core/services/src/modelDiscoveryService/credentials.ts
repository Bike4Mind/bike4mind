import { isPlaceholderApiKey, type IAdminSettings } from '@bike4mind/common';
import { getEffectiveLLMApiKeys, type GetEffectiveLLMApiKeysAdapters } from '@bike4mind/auth/apiKeyService';
import type { DiscoveryCredentials, DiscoveryEnv } from './types';

/**
 * What `keyOrExpired` returns for a key past its expiry. It is not a credential:
 * a source that fetches with the literal string earns a 401 and raises a false
 * source-failure alarm, so it is normalized to "unconfigured" here (sec 5.7).
 */
export const EXPIRED_KEY_SENTINEL = 'expired';

/** ElevenLabs is absent from getEffectiveLLMApiKeys and has its own admin setting. */
const ELEVENLABS_SETTING: IAdminSettings['settingName'] = 'elevenLabsServerApiKey';

/**
 * Discovery-only env keys, preferred over the demo-key tier (sec 5.7). The `null`
 * user path reaches only AdminSettings demo keys, so a hosted deploy without one
 * silently stops watching its largest catalog surface; reading the secret
 * directly makes hosted discovery deterministic instead of dependent on a
 * setting that exists for a different purpose. Unlike `envKey`, this is NOT
 * gated on B4M_SELF_HOST - hosted is the case it exists for.
 */
const DISCOVERY_ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
} as const;

export type LLMKeyResolver = typeof getEffectiveLLMApiKeys;

export interface DiscoveryCredentialAdapters extends GetEffectiveLLMApiKeysAdapters {
  /**
   * Seam for the sentinel and env-preference tests. The `null` user path cannot
   * itself produce `'expired'` (it never reads a per-user row), so the rule is
   * only exercisable by substituting the resolver.
   */
  resolveLLMKeys?: LLMKeyResolver;
}

/**
 * A value that is absent, blank, the expiry sentinel, or any recognized
 * placeholder is not a credential. The placeholder matters most on the env tier:
 * DISCOVERY_ENV_KEYS is live on hosted, so on a stage where `sst secret set`
 * never ran the placeholder would beat the AdminSettings key and every request
 * would go out as `Bearer not-configured`. isPlaceholderApiKey rather than
 * isPlaceholderValue: it is the repo's documented superset, and the values a
 * half-filled .env actually carries (your-api-key, REPLACE_ME, dummy) are in the
 * superset only. Sending one upstream buys a 401 and a false SourceFailures alarm.
 */
const usable = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === EXPIRED_KEY_SENTINEL || isPlaceholderApiKey(trimmed)) return null;
  return trimmed;
};

/**
 * Resolve the credentials a discovery run fetches with. No code path here passes
 * the string `'system'` as a userId: that is not a sentinel, it produces a literal
 * `find({ userId: 'system' })` that returns nothing and then falls through to the
 * demo-key tier by accident. `null` is the documented no-user path.
 */
export async function getDiscoveryCredentials(
  adapters: DiscoveryCredentialAdapters,
  env: DiscoveryEnv = process.env
): Promise<DiscoveryCredentials> {
  const resolve = adapters.resolveLLMKeys ?? getEffectiveLLMApiKeys;
  const [keys, elevenLabsSetting] = await Promise.all([
    resolve(null, adapters),
    adapters.db.adminSettings.findBySettingName(ELEVENLABS_SETTING),
  ]);

  const isSelfHost = env.B4M_SELF_HOST === 'true';

  return {
    openai: usable(env[DISCOVERY_ENV_KEYS.openai]) ?? usable(keys.openai),
    anthropic: usable(env[DISCOVERY_ENV_KEYS.anthropic]) ?? usable(keys.anthropic),
    gemini: usable(env[DISCOVERY_ENV_KEYS.gemini]) ?? usable(keys.gemini),
    xai: usable(env[DISCOVERY_ENV_KEYS.xai]) ?? usable(keys.xai),
    kimi: usable(env[DISCOVERY_ENV_KEYS.kimi]) ?? usable(keys.kimi),
    bfl: usable(keys.bfl),
    voyageai: usable(keys.voyageai),
    ollama: usable(keys.ollama),
    imageGen: usable(keys.imageGen),
    elevenlabs: usable(elevenLabsSetting?.settingValue),
    awsIam: !isSelfHost,
    isSelfHost,
  };
}

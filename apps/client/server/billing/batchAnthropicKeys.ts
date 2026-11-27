import { isPlaceholderApiKey } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';

/**
 * Platform Anthropic keys for batch transforms, in preference order: the key platform completions
 * resolve (the admin setting, or the self-host environment), then the deployment secret. A user's own
 * key is never used. Submit takes the first; a poll walks the list with firstKeyHolding.
 */
export async function batchAnthropicKeys(): Promise<string[]> {
  const platform = await apiKeyService.getEffectiveLLMApiKeys(null, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  const keys = [platform.anthropic, Config.ANTHROPIC_API_KEY].filter(
    (key): key is string => typeof key === 'string' && !isPlaceholderApiKey(key)
  );
  return [...new Set(keys)];
}

/** Anthropic's answer for a batch id that the key's workspace does not hold. */
const notHeldByKey = (error: unknown): boolean => (error as { status?: unknown } | null)?.status === 404;

/**
 * Reads a batch with the first key whose workspace holds it. Anthropic serves a batch only to keys of
 * the workspace that created it, so a batch submitted before the preferred key changed is still read
 * with the key that submitted it. Any other failure, and a miss on the last key, is thrown as is.
 */
export async function firstKeyHolding<T>(
  keys: readonly string[],
  read: (key: string) => Promise<T>
): Promise<{ key: string; value: T }> {
  for (const key of keys.slice(0, -1)) {
    try {
      return { key, value: await read(key) };
    } catch (error) {
      if (!notHeldByKey(error)) throw error;
    }
  }
  const last = keys[keys.length - 1];
  return { key: last, value: await read(last) };
}

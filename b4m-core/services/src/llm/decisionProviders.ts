import { isPlaceholderApiKey, type DecisionProviderId } from '@bike4mind/common';
import { getEffectiveLLMApiKeys } from '../apiKeyService';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';

export type DecisionProviderKeys = Awaited<ReturnType<typeof getEffectiveLLMApiKeys>>;

/**
 * A provider key that a decision call may actually use. getEffectiveLLMApiKeys answers an expired
 * per-user key with a truthy sentinel, and a half-filled env tier carries placeholders; neither is
 * a credential, so both read as absent. Mirrors the generation-job key rule.
 */
export const usableDecisionApiKey = (raw: string | null | undefined): string | null => {
  if (!raw || raw === EXPIRED_KEY_SENTINEL || isPlaceholderApiKey(raw)) return null;
  return raw;
};

/** Each vendor adds its case here; the exhaustive switch makes the compiler demand it. */
export const selectDecisionProviderKey = (
  provider: DecisionProviderId,
  keys: DecisionProviderKeys
): string | null | undefined => {
  switch (provider) {
    case 'test':
      return 'test-key';
    // The user's own OpenAI key, else the admin demo key, else the deployment env key.
    case 'openai':
      return keys.openai;
    case 'typesafe':
      return keys.typesafe;
    default: {
      const unhandled: never = provider;
      throw new Error(`no key mapping for decision provider ${String(unhandled)}`);
    }
  }
};

// The one key rule every consumer shares, so the model list, a decision request and tool
// availability cannot disagree about whether a provider is callable.
export const usableDecisionProviderKey = (provider: DecisionProviderId, keys: DecisionProviderKeys): string | null =>
  provider === 'test'
    ? (selectDecisionProviderKey(provider, keys) ?? null)
    : usableDecisionApiKey(selectDecisionProviderKey(provider, keys));

/**
 * Whether this caller has any credential a decision model could be called with. `keys` may be the
 * absence of a lookup (a deployment-wide caller), which reads as an empty table. The test provider
 * is deterministic and free, so it counts only when the deployment opted in - the same gate the
 * provider registry applies.
 */
export const hasUsableDecisionProvider = (keys: DecisionProviderKeys | null | undefined): boolean => {
  const table = keys ?? ({} as DecisionProviderKeys);
  return (
    usableDecisionProviderKey('openai', table) !== null ||
    usableDecisionProviderKey('typesafe', table) !== null ||
    process.env.ENABLE_TEST_DECISION_PROVIDER === 'true'
  );
};

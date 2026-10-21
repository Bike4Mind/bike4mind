import { z } from 'zod';
import {
  getDecisionModelCapabilities,
  isPlaceholderApiKey,
  type DecisionModelId,
  type DecisionProviderId,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  createDecisionProviderRegistry,
  OpenAiDecisionProvider,
  SystemOneDecisionProvider,
  TestDecisionProvider,
  type DecisionProvider,
  type DecisionProviderRegistry,
} from '@bike4mind/utils/decisionProviders';
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

const SystemOneBaseUrlSchema = z
  .string()
  .url()
  .refine(value => {
    // refine also runs when .url() has already failed, so the string may not parse.
    const url = URL.canParse(value) ? new URL(value) : null;
    return (
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.host !== '' &&
      url.search === '' &&
      url.hash === ''
    );
  });

/** TypeSafe's hosted API unless SYSTEMONE_BASE_URL points at a self-hosted deployment. */
const systemOneProviders = (env: NodeJS.ProcessEnv, logger: Logger): DecisionProvider[] => {
  const configured = env.SYSTEMONE_BASE_URL?.trim();
  if (!configured) return [new SystemOneDecisionProvider()];
  const parsed = SystemOneBaseUrlSchema.safeParse(configured);
  // Drop only the Jev models (they answer model_unavailable) so one bad self-host setting cannot take down every decisions model.
  if (!parsed.success) {
    logger.error(
      'SYSTEMONE_BASE_URL must be a valid absolute URL (e.g. https://laya.example.com); Jev models are disabled'
    );
    return [];
  }
  return [new SystemOneDecisionProvider(parsed.data.replace(/\/+$/, ''))];
};

/** The test provider is deterministic and free, so it is registered only on an explicit opt-in (never production). */
export const buildDecisionProviders = (
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = new Logger()
): DecisionProvider[] => [
  new OpenAiDecisionProvider(),
  ...systemOneProviders(env, logger),
  ...(env.ENABLE_TEST_DECISION_PROVIDER === 'true' ? [new TestDecisionProvider()] : []),
];

/**
 * The models this deployment serves. Memoized on the two env inputs that decide registration, so a
 * caller on a hot path does not rebuild the registry (and re-log a bad SYSTEMONE_BASE_URL) per
 * request, while a changed env - a test, a hot reload - still sees the new registration.
 */
let cached: { signature: string; registry: DecisionProviderRegistry } | undefined;

export const getDecisionProviderRegistry = (env: NodeJS.ProcessEnv = process.env): DecisionProviderRegistry => {
  const signature = `${env.SYSTEMONE_BASE_URL ?? ''}|${env.ENABLE_TEST_DECISION_PROVIDER ?? ''}`;
  if (cached?.signature !== signature) {
    cached = { signature, registry: createDecisionProviderRegistry(buildDecisionProviders(env)) };
  }
  return cached.registry;
};

/**
 * Whether any model this deployment registers belongs to a provider this caller can call. Derived
 * from the registry (not a hand-written provider list) so availability, the model list and the
 * runner cannot disagree about a deployment that registers no models for a key it holds.
 */
export const hasCallableDecisionModel = (
  models: readonly DecisionModelId[],
  keys: DecisionProviderKeys | null | undefined
): boolean => {
  const table = keys ?? ({} as DecisionProviderKeys);
  return models.some(model => usableDecisionProviderKey(getDecisionModelCapabilities(model).provider, table) !== null);
};

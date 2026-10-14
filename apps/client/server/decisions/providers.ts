import { z } from 'zod';
import type { DecisionProviderId } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import {
  createDecisionProviderRegistry,
  OpenAiDecisionProvider,
  SystemOneDecisionProvider,
  TestDecisionProvider,
  type DecisionProvider,
  type DecisionProviderRegistry,
} from '@bike4mind/utils/decisionProviders';
import { usableApiKey } from '@server/generationJobs/wiring';

type EffectiveKeys = Awaited<ReturnType<typeof apiKeyService.getEffectiveLLMApiKeys>>;

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

let registry: DecisionProviderRegistry | undefined;
export const getDecisionProviderRegistry = (): DecisionProviderRegistry =>
  (registry ??= createDecisionProviderRegistry(buildDecisionProviders()));

/** Each vendor adds its case here; the exhaustive switch makes the compiler demand it. */
export const selectDecisionProviderKey = (
  provider: DecisionProviderId,
  keys: EffectiveKeys
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

const loadEffectiveKeys = (userId: string, logger: Logger): Promise<EffectiveKeys> =>
  apiKeyService.getEffectiveLLMApiKeys(
    userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );

// The one key rule both resolvers below share, so the model list and a decision request cannot disagree.
const usableDecisionProviderKey = (provider: DecisionProviderId, keys: EffectiveKeys): string | null =>
  provider === 'test'
    ? (selectDecisionProviderKey(provider, keys) ?? null)
    : usableApiKey(selectDecisionProviderKey(provider, keys));

export const resolveDecisionProviderKey = async (
  userId: string,
  provider: DecisionProviderId,
  logger: Logger
): Promise<string | null> => {
  const keys = provider === 'test' ? ({} as EffectiveKeys) : await loadEffectiveKeys(userId, logger);
  return usableDecisionProviderKey(provider, keys);
};

/** The providers this caller has a usable key for, read with one key lookup. A failed lookup rejects. */
export const resolveCallableDecisionProviders = async (
  userId: string,
  providers: readonly DecisionProviderId[],
  logger: Logger
): Promise<ReadonlySet<DecisionProviderId>> => {
  const needsKeys = providers.some(provider => provider !== 'test');
  const keys = needsKeys ? await loadEffectiveKeys(userId, logger) : ({} as EffectiveKeys);
  return new Set(providers.filter(provider => usableDecisionProviderKey(provider, keys) !== null));
};

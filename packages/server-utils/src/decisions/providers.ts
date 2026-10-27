import type { DecisionProviderId } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { usableDecisionProviderKey, type DecisionProviderKeys } from '@bike4mind/services/llm';
import { getSettingsByNames } from '@bike4mind/utils';

// The provider set and its registration rules live in b4m-core/services, so tool availability (also
// b4m-core) reads the same registry the runner and the model list do. Re-exported here to keep the
// routes and their tests on one import site.
export {
  buildDecisionProviders,
  getDecisionProviderRegistry,
  selectDecisionProviderKey,
} from '@bike4mind/services/llm';

type EffectiveKeys = DecisionProviderKeys;

const loadEffectiveKeys = (userId: string, logger: Logger): Promise<EffectiveKeys> =>
  apiKeyService.getEffectiveLLMApiKeys(
    userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );

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

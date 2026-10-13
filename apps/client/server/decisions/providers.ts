import { z } from 'zod';
import type { DecisionProviderId } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
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

const SystemOneBaseUrlSchema = z.string().url();

/** TypeSafe's hosted API unless SYSTEMONE_BASE_URL points at a self-hosted deployment; a malformed value fails loudly. */
const systemOneBaseUrl = (env: NodeJS.ProcessEnv): string | undefined => {
  const configured = env.SYSTEMONE_BASE_URL?.trim();
  if (!configured) return undefined;
  const parsed = SystemOneBaseUrlSchema.safeParse(configured);
  if (!parsed.success)
    throw new Error('SYSTEMONE_BASE_URL must be a valid absolute URL (e.g. https://laya.example.com)');
  return parsed.data.replace(/\/+$/, '');
};

/** The test provider is deterministic and free, so it is registered only on an explicit opt-in (never production). */
export const buildDecisionProviders = (env: NodeJS.ProcessEnv = process.env): DecisionProvider[] => [
  new OpenAiDecisionProvider(),
  new SystemOneDecisionProvider(systemOneBaseUrl(env)),
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

export const resolveDecisionProviderKey = async (
  userId: string,
  provider: DecisionProviderId,
  logger: Logger
): Promise<string | null> => {
  if (provider === 'test') return selectDecisionProviderKey(provider, {} as EffectiveKeys) ?? null;
  const keys = await apiKeyService.getEffectiveLLMApiKeys(
    userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );
  return usableApiKey(selectDecisionProviderKey(provider, keys));
};

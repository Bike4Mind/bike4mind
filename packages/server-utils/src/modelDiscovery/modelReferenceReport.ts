import {
  adminSettingsRepository,
  apiKeyRepository,
  modelCatalogRepository,
  whenCatalogSeeded,
} from '@bike4mind/database';
import {
  buildApiKeyTable,
  catalogLifecycles,
  checkStaleModelReferences,
  getAvailableModels,
} from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';
import { builtInAgentModelReferences } from '@bike4mind/services/llm/agents/ServerAgentStore';
import { DEFAULT_FALLBACK_CHAIN, FALLBACK_PREFERENCES, getSettingsByNames } from '@bike4mind/utils';
import { allSettingDefinitions, type SettingKey } from '@bike4mind/common';
// The audit cron enters here without baseApi, so load the contributed definitions for it too.
import '../lib/settings/registerContributedSettings';

// voiceSessionTranscriptionModel is deliberately absent: it goes straight to the
// OpenAI Realtime API (pages/api/ai/voice-sessions), never through the merged
// model list, so that list cannot judge it and flags the *-transcribe options.
const MODEL_SETTINGS = ['DefaultAPIModel', 'OrgFeedbackSummaryModel', 'EmailAnalysisModel'] as const;

export async function configuredModelReferences(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    MODEL_SETTINGS.map(async key => [key, await adminSettingsRepository.getSettingsValue(key)] as const)
  );
  const references: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value) references[key] = value;
  }
  const defaults = await adminSettingsRepository.getSettingsValue('orchestrationDefaults');
  if (!defaults) throw new Error('Orchestration defaults are unavailable for the model reference audit');
  for (const [index, model] of defaults.fallbackModels.entries()) {
    references[`orchestrationDefaults.fallbackModels.${index}`] = model;
  }
  if (defaults.intentClassifier.enabled) {
    references['orchestrationDefaults.intentClassifier.primaryModel'] = defaults.intentClassifier.primaryModel;
    for (const [index, model] of defaults.intentClassifier.fallbackModels.entries()) {
      references[`orchestrationDefaults.intentClassifier.fallbackModels.${index}`] = model;
    }
  }
  for (const definition of allSettingDefinitions()) {
    if (!definition.modelReferences) continue;
    // getSettingsValue resolves a contributed key as well; only its type is limited to core keys.
    const value: unknown = await adminSettingsRepository.getSettingsValue(definition.key as SettingKey);
    if (!value) continue;
    for (const [path, model] of Object.entries(definition.modelReferences(value))) {
      references[`${definition.key}.${path}`] = model;
    }
  }
  return references;
}

/** Reused by the operator API and watchdog; callers connect the database first. */
export async function modelReferenceReport() {
  if (!(await whenCatalogSeeded())) throw new Error('Catalog bootstrap failed before the model reference audit');
  const keys = await apiKeyService.getEffectiveLLMApiKeys(null, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  const [models, rows, configuredModels] = await Promise.all([
    getAvailableModels(buildApiKeyTable(keys), { includePrivate: true, perBackendTimeoutMs: 10_000 }),
    modelCatalogRepository.rowsInForce(),
    configuredModelReferences(),
  ]);
  return checkStaleModelReferences({
    models,
    lifecycles: catalogLifecycles(rows),
    fallbackChains: FALLBACK_PREFERENCES,
    defaultChain: DEFAULT_FALLBACK_CHAIN,
    agentModels: builtInAgentModelReferences(),
    configuredModels,
  });
}

import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getSlackDb } from '../di/registry';

type SlackOption = {
  text: { type: 'plain_text'; text: string };
  value: string;
};

type SlackOptionGroup = {
  label: { type: 'plain_text'; text: string };
  options: SlackOption[];
};

/**
 * Group label per backend, in dropdown order. Total over ModelBackend so a new
 * provider is a compile error here rather than an unlabeled group sorted last.
 * BFL and LocalImage never survive the text filter below, and VoyageAI is never
 * listed at all; they are here so the Record stays total.
 */
export const BACKEND_DISPLAY_NAMES: Readonly<Record<ModelBackend, string>> = {
  [ModelBackend.OpenAI]: 'OpenAI',
  [ModelBackend.Anthropic]: 'Anthropic',
  [ModelBackend.Bedrock]: 'Bedrock',
  [ModelBackend.Gemini]: 'Gemini',
  [ModelBackend.XAI]: 'xAI',
  [ModelBackend.Kimi]: 'Moonshot (Kimi)',
  [ModelBackend.DeepSeek]: 'DeepSeek',
  [ModelBackend.Ollama]: 'Ollama',
  [ModelBackend.AWS]: 'AWS',
  [ModelBackend.BFL]: 'Black Forest Labs',
  [ModelBackend.VoyageAI]: 'Voyage AI',
  [ModelBackend.LocalImage]: 'Local image',
};

const BACKEND_ORDER = Object.keys(BACKEND_DISPLAY_NAMES) as ModelBackend[];

// views.open must land within Slack's 3s trigger_id window, so one slow backend
// (a blackholed Ollama or IMAGE_GEN_BASE_URL host) contributes nothing rather
// than failing the whole modal. Same deadline as the web picker.
const PER_BACKEND_TIMEOUT_MS = 2_000;

/**
 * Fetch enabled text models from all backends and return them as Slack
 * option_groups for static_select dropdowns. Lists through the same
 * getAvailableModels fan-out /api/models uses, so a provider the web picker can
 * reach is reachable here without a second construction map to keep in sync.
 */
export async function buildSlackModelOptionsFromDashboard(): Promise<{
  option_groups: SlackOptionGroup[];
  flat: SlackOption[];
}> {
  try {
    const { apiKeyRepository, adminSettingsRepository, AdminSettings } = getSlackDb();
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository as any, adminSettings: adminSettingsRepository as any },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);

    // Deprecated models are already filtered inside getAvailableModels.
    let allModels = await getAvailableModels(buildApiKeyTable(coreKeys), {
      includePrivate: false,
      perBackendTimeoutMs: PER_BACKEND_TIMEOUT_MS,
    });

    // Filter to text models only (Slack chat uses text models)
    allModels = allModels.filter(m => m.type === 'text');

    // Apply admin LLM configurations (enabled/disabled)
    const adminSetting = await (AdminSettings as any).findOne({ settingName: 'llmModelConfigurations' });
    const configurations = Array.isArray(adminSetting?.settingValue) ? adminSetting.settingValue : [];
    const configMap = new Map<string, { enabled: boolean }>();
    for (const cfg of configurations) {
      if (cfg && typeof cfg === 'object' && 'id' in cfg && 'enabled' in cfg) {
        configMap.set(cfg.id as string, { enabled: cfg.enabled as boolean });
      }
    }

    // Filter: models without a saved config default to enabled; explicitly disabled models are excluded
    allModels = allModels.filter(m => {
      const cfg = configMap.get(m.id);
      return cfg ? cfg.enabled !== false : true;
    });

    // Sort by rank (lower = higher priority), then name
    allModels.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name));

    // Group by backend
    const grouped = new Map<ModelBackend, ModelInfo[]>();
    for (const model of allModels) {
      const key = model.backend;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(model);
    }

    const option_groups: SlackOptionGroup[] = [];
    const flat: SlackOption[] = [];

    for (const backend of BACKEND_ORDER) {
      const models = grouped.get(backend);
      if (!models?.length) continue;

      const options: SlackOption[] = models.map(m => ({
        text: { type: 'plain_text' as const, text: m.name },
        value: m.id,
      }));

      option_groups.push({
        label: { type: 'plain_text' as const, text: BACKEND_DISPLAY_NAMES[backend] },
        options,
      });

      flat.push(...options);
    }

    if (option_groups.length === 0) {
      Logger.warn('[Slack] No models returned from any backend — model dropdown will be empty');
    }

    return { option_groups, flat };
  } catch (error) {
    Logger.error('[Slack] Failed to fetch dynamic model options', { error });
    return { option_groups: [], flat: [] };
  }
}

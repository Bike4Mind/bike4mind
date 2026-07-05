import {
  AnthropicBackend,
  UndifferentiatedBedrockBackend,
  GeminiBackend,
  OllamaBackend,
  OpenAIBackend,
  XAIBackend,
  AWSBackend,
} from '@bike4mind/llm-adapters';
import { ModelBackend } from '@bike4mind/common';
import type { ModelInfo } from '@bike4mind/common';
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

/** Display names for backend groupings in the Slack dropdown */
const BACKEND_DISPLAY_NAMES: Partial<Record<ModelBackend, string>> = {
  [ModelBackend.OpenAI]: 'OpenAI',
  [ModelBackend.Anthropic]: 'Anthropic',
  [ModelBackend.Bedrock]: 'Bedrock',
  [ModelBackend.Gemini]: 'Gemini',
  [ModelBackend.XAI]: 'xAI',
  [ModelBackend.Ollama]: 'Ollama',
  [ModelBackend.AWS]: 'AWS',
};

/**
 * Fetch enabled text models from all backends (matching the web UI /api/models flow)
 * and return them as Slack option_groups for static_select dropdowns.
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

    const apiKeys = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };

    const backends: Partial<Record<ModelBackend, { getModelInfo(): Promise<ModelInfo[]> }>> = {
      [ModelBackend.OpenAI]: apiKeys.openai ? new OpenAIBackend(apiKeys.openai) : undefined,
      [ModelBackend.Anthropic]: apiKeys.anthropic ? new AnthropicBackend(apiKeys.anthropic) : undefined,
      [ModelBackend.Bedrock]: new UndifferentiatedBedrockBackend(),
      [ModelBackend.Gemini]: apiKeys.gemini ? new GeminiBackend(apiKeys.gemini) : undefined,
      [ModelBackend.Ollama]: apiKeys.ollama ? new OllamaBackend(apiKeys.ollama) : undefined,
      [ModelBackend.XAI]: apiKeys.xai ? new XAIBackend(apiKeys.xai) : undefined,
      [ModelBackend.AWS]: new AWSBackend(),
    };

    // Fetch models from all backends in parallel
    const backendResults = await Promise.allSettled(
      Object.entries(backends).map(async ([backendName, backend]) => {
        if (!backend) return { backendName, models: [] as ModelInfo[] };
        const models = (await backend.getModelInfo()).filter(m => !m.private);
        return { backendName, models };
      })
    );

    let allModels = backendResults
      .map((result, index) => {
        if (result.status === 'fulfilled') return result.value.models;
        const backendName = Object.keys(backends)[index];
        Logger.warn('[Slack] Failed to fetch models from backend', {
          backend: backendName,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return [];
      })
      .flat();

    // Filter deprecated models
    const today = new Date(new Date().toISOString().slice(0, 10));
    allModels = allModels.filter(m => {
      if (!m.deprecationDate) return true;
      const cutoff = new Date(m.deprecationDate + 'T00:00:00Z');
      return today.getTime() < cutoff.getTime();
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
    const grouped = new Map<string, ModelInfo[]>();
    for (const model of allModels) {
      const key = model.backend;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(model);
    }

    // Build option_groups in a stable backend order
    const backendOrder = [
      ModelBackend.OpenAI,
      ModelBackend.Anthropic,
      ModelBackend.Bedrock,
      ModelBackend.Gemini,
      ModelBackend.XAI,
      ModelBackend.Ollama,
      ModelBackend.AWS,
    ];

    const option_groups: SlackOptionGroup[] = [];
    const flat: SlackOption[] = [];

    for (const backend of backendOrder) {
      const models = grouped.get(backend);
      if (!models?.length) continue;

      const options: SlackOption[] = models.map(m => ({
        text: { type: 'plain_text' as const, text: m.name },
        value: m.id,
      }));

      option_groups.push({
        label: { type: 'plain_text' as const, text: BACKEND_DISPLAY_NAMES[backend] || backend },
        options,
      });

      flat.push(...options);
    }

    // Also include any backends not in backendOrder (future-proofing)
    for (const [backend, models] of grouped) {
      if (backendOrder.includes(backend as ModelBackend)) continue;
      if (!models.length) continue;

      const options: SlackOption[] = models.map(m => ({
        text: { type: 'plain_text' as const, text: m.name },
        value: m.id,
      }));

      option_groups.push({
        label: { type: 'plain_text' as const, text: BACKEND_DISPLAY_NAMES[backend as ModelBackend] || backend },
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

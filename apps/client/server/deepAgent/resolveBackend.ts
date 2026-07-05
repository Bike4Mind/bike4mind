import { getAvailableModels, getLlmByModel, type ICompletionBackend } from '@bike4mind/llm-adapters';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';

/**
 * Default model for deep-agent cognition. orient/reflect/groom are cheap
 * structured calls, so the light (Haiku) tier is the right default; callers can
 * override per wake. (The act step, once wired, may use a heavier tier.)
 */
export const DEFAULT_WAKE_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface ResolvedBackend {
  llm: ICompletionBackend;
  modelId: string;
}

/** Build the system-level API key table from DB-backed admin settings. */
export async function buildSystemApiKeyTable(logger: Logger) {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };
  const keys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
  return {
    openai: keys.openai || undefined,
    anthropic: keys.anthropic || undefined,
    gemini: keys.gemini || undefined,
    bfl: keys.bfl || undefined,
    ollama: keys.ollama || undefined,
    xai: keys.xai || undefined,
  };
}

/**
 * Resolve a completion backend for the given model id, or null if it is not
 * available (no key, unknown id).
 */
export async function resolveDeepAgentBackend(
  modelId: string,
  logger: Logger,
  // Internal id of the agent's owner, forwarded to direct providers for per-user
  // abuse attribution. Present on the user-triggered first-wake path; the
  // recurring cron-wake path (deepAgentWake.ts -> wakeHandler) does not yet source
  // the owner (charter.identity.ownerUserId) at enqueue time - follow-up.
  endUserId?: string
): Promise<ResolvedBackend | null> {
  const apiKeyTable = await buildSystemApiKeyTable(logger);
  const models = await getAvailableModels(apiKeyTable);
  const modelInfo = models.find(m => m.id === modelId);
  if (!modelInfo) {
    logger.warn('deep agent wake: model not available', { modelId });
    return null;
  }
  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId });
  if (!llm) {
    logger.warn('deep agent wake: failed to init LLM backend', { modelId });
    return null;
  }
  return { llm, modelId: modelInfo.id };
}

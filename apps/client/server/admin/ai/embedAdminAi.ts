import {
  AdminAiConfigSchema,
  OpenAIEmbeddingModel,
  getEmbeddingModelCapabilities,
  getEmbeddingModelCost,
  hasPublishedEmbeddingRate,
  type AdminAiConfig,
  type AdminAiFeature,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { resolveEmbeddingProvider } from '@bike4mind/services/llm/embeddingProviders';
import { getSettingsByNames, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveAdminAiSpend } from './budget';
import { AdminAiSkip, type AdminAiSkipReason } from './adminAiSkip';
import { pseudonymiseEvidence } from './pseudonymiseEvidence';

export const FEEDBACK_EMBEDDING_MODEL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;
export const loadFeedbackAiConfig = async (): Promise<AdminAiConfig> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['adminAiConfig'], skipCache: true }
  );
  return getSettingsValue('adminAiConfig', settings, AdminAiConfigSchema.parse({}));
};

type EmbeddingResult = { vectors: number[][]; inputTokens?: number };
export type AdminAiEmbeddingDeps = {
  loadConfig?: typeof loadFeedbackAiConfig;
  embed?: (text: string) => Promise<EmbeddingResult>;
  reserve?: typeof reserveAdminAiSpend;
};

export async function embedAdminAi(
  feature: AdminAiFeature,
  text: string,
  deps: AdminAiEmbeddingDeps = {}
): Promise<
  | { ok: true; vector: number[]; model: typeof FEEDBACK_EMBEDDING_MODEL; costUsd: number }
  | { ok: false; skip: AdminAiSkipReason }
> {
  let reservation: Awaited<ReturnType<typeof reserveAdminAiSpend>> | undefined;
  try {
    const config = await (deps.loadConfig ?? loadFeedbackAiConfig)();
    const limits = config.features[feature];
    if (!config.enabled || limits.mode === 'off') return { ok: false, skip: 'disabled' };
    const redacted = String(pseudonymiseEvidence(text.slice(0, 3000), ''));
    const model = FEEDBACK_EMBEDDING_MODEL;
    if (!hasPublishedEmbeddingRate(model)) return { ok: false, skip: 'no_model' };
    // UTF-8 bytes bound token count without relying on an approximate tokenizer.
    const ceilingTokens = Buffer.byteLength(redacted, 'utf8');
    const caps = getEmbeddingModelCapabilities(model);
    if (!redacted.trim() || ceilingTokens > caps.maxInputTokens) return { ok: false, skip: 'invalid_output' };
    let embed = deps.embed;
    if (!embed) {
      const keys = await apiKeyService.getEffectiveLLMApiKeys('system', {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      });
      const { provider, missing } = resolveEmbeddingProvider(model, keys);
      if (missing || !provider) return { ok: false, skip: 'no_model' };
      embed = input =>
        provider.embed({ model, inputs: [input], inputType: 'document' }, { signal: AbortSignal.timeout(8000) });
    }
    reservation = await (deps.reserve ?? reserveAdminAiSpend)({
      feature,
      maxCostUsd: getEmbeddingModelCost(model, ceilingTokens),
      limits: { ...limits, monthlyCapUsd: config.monthlyCapUsd },
    });
    const result = await embed(redacted);
    const vector = result.vectors[0];
    if (result.vectors.length !== 1 || vector?.length !== caps.dimensions.native || !vector.every(Number.isFinite)) {
      throw new AdminAiSkip('invalid_output');
    }
    const tokens = result.inputTokens;
    const costUsd = getEmbeddingModelCost(
      model,
      tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 ? Math.max(tokens, 0) : ceilingTokens
    );
    if (costUsd > getEmbeddingModelCost(model, ceilingTokens)) throw new AdminAiSkip('invalid_output');
    await reservation.settle(costUsd);
    reservation = undefined;
    return { ok: true, vector, model, costUsd };
  } catch (error) {
    if (reservation) await reservation.fail().catch(() => undefined);
    new Logger({ metadata: { service: 'adminAiEmbedding' } }).warn('Admin AI embedding skipped', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return { ok: false, skip: error instanceof AdminAiSkip ? error.reason : 'provider_down' };
  }
}

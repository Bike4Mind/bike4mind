import { adminSettingsRepository, apiKeyRepository, rapidReplyResultRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { apiKeyService, meterCompletionBackend, type CompletionMeter } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { resolveRapidModel } from '@server/rapidReply/resolveRapidModel';

// 4,000 chars (~1k tokens): the 50-token ack only needs the gist of the request, and the UI sends the
// whole prompt, so truncate rather than reject.
export const RAPID_REPLY_MAX_MESSAGE_CHARS = 4_000;

const DEFAULT_RAPID_SYSTEM_PROMPT =
  `IMPORTANT: Provide a quick, friendly acknowledgment (1 sentence max). ` +
  `The main AI is loading full context and will provide the complete answer.`;

export type RapidReplyMappingInput = {
  id: string;
  rapidModelId: string;
  systemPrompt?: string;
  maxTokens?: number;
  maxLatency?: number;
};

export type RapidReplyGeneration =
  | { status: 'generated'; content: string; modelId: string; latency: number }
  | { status: 'skipped'; reason: 'model_unavailable' | 'empty_response' };

/**
 * Runs a mapping's rapid model once on the platform key. Shared by the chat endpoint
 * (pages/api/ai/rapid-reply.ts) and the admin test (pages/api/admin/rapid-reply/test.ts) so the
 * test measures the same call chat makes. Credit refusals and provider errors propagate.
 * `latency` (ms) covers only the model call.
 */
export async function generateRapidReply({
  mapping,
  message,
  userId,
  logger,
  meter,
}: {
  mapping: RapidReplyMappingInput;
  message: string;
  userId: string;
  logger: Logger;
  meter: CompletionMeter;
}): Promise<RapidReplyGeneration> {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };
  // Through buildApiKeyTable, not a literal: getEffectiveLLMApiKeys returns a
  // provider-keyed shape and getAvailableModels reads a backend-keyed one, and that
  // helper is the ratchet that keeps every new provider from being silently absent here.
  const apiKeyTable = buildApiKeyTable(await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters));
  const models = await getAvailableModels(apiKeyTable);
  // Degrades a rotted mapping to a reachable fast model instead of throwing; see
  // resolveRapidModel for why a sunset rapid model must never fail the request.
  const resolution = resolveRapidModel({
    mappedModelId: mapping.rapidModelId,
    models,
    apiKeyTable,
    logger,
    endUserId: userId,
    mappingId: mapping.id,
  });
  if (resolution.status === 'unavailable') {
    return { status: 'skipped', reason: 'model_unavailable' };
  }

  const { modelId: rapidModelId, llm: rapidLlm } = resolution;
  const rapidModelInfo = models.find(m => m.id === rapidModelId);
  if (!rapidModelInfo) {
    return { status: 'skipped', reason: 'model_unavailable' };
  }

  const rapidMessages = [
    { role: 'system' as const, content: mapping.systemPrompt || DEFAULT_RAPID_SYSTEM_PROMPT },
    { role: 'user' as const, content: message.slice(0, RAPID_REPLY_MAX_MESSAGE_CHARS) },
  ];
  // maxTokens, not max_tokens: the adapters only read the camelCase key, and the credit hold is
  // sized from this same value.
  const rapidOptions = {
    maxTokens: Math.min(mapping.maxTokens || 50, 50),
    temperature: 0.9,
    stream: false,
  };

  // Admin-mapped model on platform keys: reserve before the call, settle after, refund on a throw.
  const meteredRapidLlm = meterCompletionBackend(rapidLlm, meter, rapidModelInfo);

  const rapidStartTime = Date.now();
  let accumulatedText = '';
  await meteredRapidLlm.complete(
    rapidModelId,
    rapidMessages,
    rapidOptions,
    async (rapidStreamedTexts: (string | null | undefined)[]) => {
      const rapidText = rapidStreamedTexts[0];
      if (rapidText) {
        accumulatedText = rapidText;
      }
    }
  );
  const latency = Date.now() - rapidStartTime;

  const content = accumulatedText.trim();
  if (content.length === 0) {
    return { status: 'skipped', reason: 'empty_response' };
  }
  return { status: 'generated', content, modelId: rapidModelId, latency };
}

/**
 * Persists a generated rapid reply. This row is what ChatCompletionProcess reads
 * (findByQuestId / findLatestBlankRapidReplyBySessionId) to hand off to the main reply.
 */
export function saveRapidReplyResult({
  questId,
  sessionId,
  userId,
  mainModelId,
  mapping,
  generation,
  ttfvt,
}: {
  questId: string | undefined;
  sessionId: string | undefined;
  userId: string;
  mainModelId: string;
  mapping: RapidReplyMappingInput;
  generation: Extract<RapidReplyGeneration, { status: 'generated' }>;
  ttfvt: number;
}) {
  return rapidReplyResultRepository.create({
    questId,
    sessionId,
    userId,
    mainModelId,
    rapidModelId: generation.modelId,
    mappingId: mapping.id,
    rapidResponse: {
      content: generation.content,
      tokenCount: generation.content.length,
      latency: generation.latency,
      cost: 0,
      ttfvt,
    },
    userInteraction: {
      wasShown: true,
      wasReplaced: false,
    },
    metrics: {
      totalLatency: generation.latency,
      latencySavings: Math.max(0, (mapping.maxLatency || 2000) - generation.latency),
      ttfvtSavings: 0,
    },
    status: 'success',
    // create() is typed with the full Mongoose Document interface, which a plain record can't satisfy.
  } as unknown as Parameters<typeof rapidReplyResultRepository.create>[0]);
}

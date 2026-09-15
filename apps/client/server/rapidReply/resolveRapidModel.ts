import type { ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  type ApiKeyTable,
  getLlmByModel,
  type ICompletionBackend,
  resolveDeprecatedModelId,
} from '@bike4mind/llm-adapters';
import { findFallbackForMissingModel } from '@bike4mind/utils';

/**
 * Which model rapid reply should actually run, for a mapping row whose `rapidModelId`
 * may no longer be reachable.
 *
 * `substitutedFor` is present only on a degraded resolution, so the caller persists the
 * model that ran rather than the one the mapping named.
 */
export type RapidModelResolution =
  { status: 'ready'; modelId: string; llm: ICompletionBackend; substitutedFor?: string } | { status: 'unavailable' };

/**
 * Resolve a rapid-reply mapping's model id to a runnable backend, degrading instead of
 * failing.
 *
 * Stored mapping rows (and the OptiHashi fallback constant in the endpoint) pin model ids
 * that age out from under them: the catalog sunsets one, an operator disables another, and
 * the row outlives its own target. Rapid reply is a best-effort latency optimization racing
 * the real completion, so every one of those states must resolve to *some* fast model or to
 * a clean "skip" - never to a throw, which is what turned each model sunset into a recurring
 * error-severity production alert.
 *
 * Three layers, in the order every other model consumer applies them:
 *  1. `resolveDeprecatedModelId` forwards a sunset id to its successor. This is also the only
 *     emitter of the alarmable `[model-sunset]` signal, so skipping it kept this whole class
 *     of breakage off the sunset dashboard.
 *  2. `disabled` is a hard stop, not a hint - a disabled model is listed so the picker can
 *     grey it out but must never run (same rule as ChatCompletionInvoke).
 *  3. `findFallbackForMissingModel` walks the shared FALLBACK_PREFERENCES chain. The chain for
 *     the Bedrock Haiku ids leads with the Anthropic-direct twin, so a substitution stays in
 *     the same latency class the optimization depends on.
 *
 * Logs the substitution and the give-up at warn: the user's chat answer is unaffected in both
 * cases, and the only thing lost is the TTFVT win. Both are logged unconditionally so a
 * silently-off rapid reply stays greppable - "never fired" has to remain distinguishable from
 * "fired and was swallowed".
 */
export function resolveRapidModel({
  mappedModelId,
  models,
  apiKeyTable,
  logger,
  endUserId,
  mappingId,
}: {
  mappedModelId: string;
  models: ModelInfo[];
  apiKeyTable: ApiKeyTable;
  logger: Logger;
  endUserId?: string | null;
  /** Named in the warn lines so an operator can find the row that rotted. */
  mappingId?: string;
}): RapidModelResolution {
  const resolvedModelId = resolveDeprecatedModelId(mappedModelId, 'rapidReply');
  const mappedModel = models.find(m => m.id === resolvedModelId);

  const llm = mappedModel?.disabled ? null : getLlmByModel(apiKeyTable, { modelInfo: mappedModel, logger, endUserId });
  if (llm) {
    return { status: 'ready', modelId: resolvedModelId, llm };
  }

  const substitute = findFallbackForMissingModel(resolvedModelId, models, apiKeyTable, logger, endUserId);
  if (!substitute) {
    logger.warn(
      `⚠️ [RapidReply] No reachable rapid model for "${mappedModelId}" (mapping ${mappingId ?? 'unknown'}); skipping`
    );
    return { status: 'unavailable' };
  }

  logger.warn(
    `⚠️ [RapidReply] "${mappedModelId}" unavailable; degrading to "${substitute.model.id}" (mapping ${mappingId ?? 'unknown'})`
  );
  return { status: 'ready', modelId: substitute.model.id, llm: substitute.backend, substitutedFor: mappedModelId };
}

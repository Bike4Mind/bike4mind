import {
  CompletionReasoningEffortSchema,
  isClaudeModelId,
  ModelBackend,
  type ModelInfo,
  type ReasoningEffort,
} from '@bike4mind/common';
import { deepseekReasoningParams } from './deepseekParams';
import { kimiReasoningParams } from './kimiParams';
import { supportsOpenAIReasoningEffort } from './openaiReasoning';
import { planReasoningEffort } from './thinkingParams';

const REASONING_EFFORTS: readonly ReasoningEffort[] = CompletionReasoningEffortSchema.options;

/**
 * openaiBackend forwards the level verbatim, and the vocabulary differs per model (the o-series
 * rejects none/minimal/xhigh), so only the levels every reasoning model accepts are advertised.
 */
const OPENAI_ACCEPTED_BY_ALL: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/** Large enough that a legacy Claude budget is never clamped away; per-request sizing is not a model property. */
const UNBOUNDED_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

/**
 * The `options.reasoningEffort` levels the model's adapter acts on, in ascending order; empty when
 * the adapter ignores the option. Each level is asked of the same request shaper the adapter uses
 * (planReasoningEffort, kimiReasoningParams, deepseekReasoningParams, supportsOpenAIReasoningEffort),
 * so a change there changes this answer too.
 *
 * `none` is listed only where it turns reasoning off. Kimi K3, DeepSeek and the adaptive Claude
 * models with no off switch map it to their lowest effort instead, so advertising it would promise
 * a reasoning-free turn they cannot give.
 */
export function reasoningEffortsFor(modelInfo: ModelInfo): ReasoningEffort[] {
  const { id } = modelInfo;
  if (modelInfo.backend === ModelBackend.OpenAI) {
    return supportsOpenAIReasoningEffort(modelInfo, id) ? [...OPENAI_ACCEPTED_BY_ALL] : [];
  }
  if (isAnthropicServed(modelInfo)) return REASONING_EFFORTS.filter(effort => claudeHonours(modelInfo, effort));
  return REASONING_EFFORTS.filter(
    effort =>
      effort !== 'none' &&
      ('reasoning_effort' in kimiReasoningParams(id, { reasoningEffort: effort }) ||
        'reasoning_effort' in deepseekReasoningParams(id, { reasoningEffort: effort }))
  );
}

/** The direct and Bedrock Claude backends are the two callers of planReasoningEffort. */
function isAnthropicServed(modelInfo: ModelInfo): boolean {
  return (
    (modelInfo.backend === ModelBackend.Anthropic || modelInfo.backend === ModelBackend.Bedrock) &&
    isClaudeModelId(modelInfo.id)
  );
}

function claudeHonours(modelInfo: ModelInfo, effort: ReasoningEffort): boolean {
  const plan = planReasoningEffort(modelInfo.id, modelInfo, effort, UNBOUNDED_MAX_TOKENS);
  if (effort !== 'none') return plan.kind !== 'default';
  if (plan.kind === 'off') return true;
  // A legacy model only thinks when asked, so leaving the request alone is already "off".
  return plan.kind === 'default' && modelInfo.can_think === true && modelInfo.thinkingStyle !== 'adaptive';
}

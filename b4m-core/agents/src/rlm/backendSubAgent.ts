import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { ReplToolFn } from './ReplContext';
import type { ReplSession } from './ReplSession';

/**
 * Build a `subAgentQuery(prompt, ...)` REPL function backed by an
 * existing `ICompletionBackend` - typically a Bedrock-routed Haiku
 * tier resolved by `resolveModelTiers()` in the tavern.
 *
 * This is the production-shape sub-LLM factory. It does NOT use the
 * Anthropic SDK directly (the alternate `subAgentQuery` in
 * `tools.ts` does that for spike convenience); it routes through the
 * same backend the rest of the agent already uses, which means:
 * - Bedrock auth + region routing handled upstream
 * - Cost / token accounting compatible with the rest of the
 *   tavern's heartbeat instrumentation
 * - No separate API key plumbing per agent
 *
 * GENERIC. No tavern-specific logic. Designed to live in
 * b4m-core/packages/agents/src/rlm/ when Quest 4 lands.
 */

export interface BackendSubAgentDeps {
  /** Backend to use for the leaf call. Typically the Haiku tier. */
  llm: ICompletionBackend;
  /** Model id (e.g. 'us.anthropic.claude-haiku-4-5-20251001-v1:0'). */
  modelId: string;
  /** Session to record cost/token usage against. */
  session: ReplSession;
  /** Default max output tokens. Default 1500. */
  defaultMaxTokens?: number;
  /** Hard ceiling on per-call max_tokens. Default 4000. */
  maxTokensCeiling?: number;
}

interface SubAgentArgs {
  prompt: string;
  max_tokens?: number;
  /**
   * Reserved for forward compatibility - agents may want to bias
   * temperature for classification vs. extraction tasks. Not yet
   * routed to the backend; default temperature is used.
   */
  temperature?: number;
}

/** Approx Haiku 4.5 pricing (per token), kept locally so we record
 *  consistent budget numbers. The actual Bedrock bill comes from AWS. */
const HAIKU_INPUT_PER_TOKEN = 0.8e-6;
const HAIKU_OUTPUT_PER_TOKEN = 4e-6;

export function buildBackendSubAgentQuery(deps: BackendSubAgentDeps): ReplToolFn {
  const defaultMax = deps.defaultMaxTokens ?? 1500;
  const ceiling = deps.maxTokensCeiling ?? 4000;

  return async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as SubAgentArgs;
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
      throw new Error('subAgentQuery: prompt must be a non-empty string');
    }
    const maxTokens = Math.min(Math.max(a.max_tokens ?? defaultMax, 16), ceiling);

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let usdCostFromBackend: number | undefined;

    await deps.llm.complete(
      deps.modelId,
      [{ role: 'user', content: a.prompt }],
      {
        temperature: 0.4,
        maxTokens,
        stream: false,
        tools: [],
      },
      async (texts, completionInfo) => {
        // ICompletionBackend hands us streamed chunks; we accumulate
        for (const t of texts) {
          if (typeof t === 'string') responseText += t;
        }
        if (completionInfo?.inputTokens) inputTokens = completionInfo.inputTokens;
        if (completionInfo?.outputTokens) outputTokens = completionInfo.outputTokens;
        if (typeof completionInfo?.usdCost === 'number') usdCostFromBackend = completionInfo.usdCost;
      }
    );

    // Prefer the backend's own cost calculation when available (Bedrock
    // sets it from the model registry); fall back to a Haiku-rate
    // estimate so the budget tracker always has a number.
    let cost: number;
    if (typeof usdCostFromBackend === 'number') {
      cost = usdCostFromBackend;
    } else {
      cost = inputTokens * HAIKU_INPUT_PER_TOKEN + outputTokens * HAIKU_OUTPUT_PER_TOKEN;
      if (!fallbackPricingWarnedFor.has(deps.modelId) && !isHaikuModel(deps.modelId)) {
        // Warn ONCE per session for a non-Haiku model when the backend
        // didn't supply usdCost - the operator should know the budget
        // tracker is using Haiku rates as an approximation.
        fallbackPricingWarnedFor.add(deps.modelId);

        Logger.globalInstance.warn(
          `[backendSubAgent] modelId="${deps.modelId}" did not provide usdCost on completion; ` +
            `falling back to Haiku-rate estimate ($0.8/M in, $4/M out). ` +
            `The recorded session cost may not match the actual bill.`
        );
      }
    }
    deps.session.recordSubLlm({
      costUsd: cost,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    });

    return responseText;
  };
}

const fallbackPricingWarnedFor = new Set<string>();
function isHaikuModel(modelId: string): boolean {
  return /haiku/i.test(modelId);
}

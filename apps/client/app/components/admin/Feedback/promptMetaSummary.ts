import type { PromptMeta } from '@bike4mind/common';

export interface PromptMetaSummary {
  model?: string;
  backend?: string;
  /** Distinct tool names in call order. */
  tools: string[];
  toolCallCount: number;
  failedToolCallCount: number;
  /** Includes cached prompt tokens; `cachedInputTokens` is that share. */
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  retrievalOutcome?: string;
  citedSourceCount: number;
}

const RETRIEVAL_OUTCOME_LABELS: Record<string, string> = {
  ok: 'Ran',
  no_lakes: 'No knowledge in scope',
  not_indexed: 'Knowledge not indexed',
  failed: 'Failed',
};

type TokenCounts = Pick<PromptMetaSummary, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens'>;

/**
 * All counts come from one basis so they add up: billed (`actual*`) when the provider reported
 * usage, else the estimate. A local settlement counts as an estimate: its `cacheReadInputTokens` is a
 * discount capped at the local input, not a token count to add (`useSessionContextUsage` reads it the
 * same way). Billed `actualInputTokens` is only the uncached tail, so cache reads
 * and writes are added back into "in"; the total is derived because `actualTotalTokens` is not
 * recorded on every path.
 */
function summarizeTokens(usage: PromptMeta['tokenUsage'] | undefined): TokenCounts {
  if (!usage) return {};

  const billed =
    usage.settledBasis !== 'local' && (usage.actualInputTokens !== undefined || usage.actualOutputTokens !== undefined);
  if (!billed) {
    const { inputTokens, outputTokens } = usage;
    const derivedTotal =
      inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;
    return { inputTokens, outputTokens, totalTokens: usage.totalTokens ?? derivedTotal };
  }

  const cached = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const inputTokens = usage.actualInputTokens !== undefined ? usage.actualInputTokens + cached : undefined;
  const outputTokens = usage.actualOutputTokens;
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : usage.actualTotalTokens;
  return { inputTokens, cachedInputTokens: cached > 0 ? cached : undefined, outputTokens, totalTokens };
}

/**
 * The short read of a turn's `promptMeta` a triaging admin needs (model, tools, tokens,
 * retrieval), never the raw object. Returns undefined when nothing worth showing was recorded, e.g. a product
 * report or a list row whose `promptMeta` was not projected.
 */
export function summarizePromptMeta(promptMeta: Partial<PromptMeta> | null | undefined): PromptMetaSummary | undefined {
  if (!promptMeta) return undefined;

  const calls = promptMeta.functionCalls ?? [];
  const calledNames = calls.map(call => call.name).filter((name): name is string => Boolean(name));
  const tools = [...new Set(calledNames.length > 0 ? calledNames : (promptMeta.narratedToolCall?.toolNames ?? []))];
  const usage = promptMeta.tokenUsage;
  const retrieval = promptMeta.retrieval;

  const summary: PromptMetaSummary = {
    model: promptMeta.model?.name,
    backend: promptMeta.model?.backend,
    tools,
    toolCallCount: calls.length,
    failedToolCallCount: calls.filter(call => call.success === false).length,
    ...summarizeTokens(usage),
    retrievalOutcome: retrieval?.attempted
      ? (RETRIEVAL_OUTCOME_LABELS[retrieval.outcome ?? ''] ?? retrieval.outcome ?? 'Unknown')
      : retrieval
        ? 'Not run'
        : undefined,
    citedSourceCount: promptMeta.citables?.length ?? 0,
  };

  const hasAnything =
    summary.model !== undefined ||
    summary.tools.length > 0 ||
    summary.totalTokens !== undefined ||
    summary.inputTokens !== undefined ||
    summary.retrievalOutcome !== undefined ||
    summary.citedSourceCount > 0;
  return hasAnything ? summary : undefined;
}

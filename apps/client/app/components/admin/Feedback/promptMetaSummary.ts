import type { PromptMeta } from '@bike4mind/common';

export interface PromptMetaSummary {
  model?: string;
  backend?: string;
  /** Distinct tool names in call order. */
  tools: string[];
  toolCallCount: number;
  failedToolCallCount: number;
  inputTokens?: number;
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

/**
 * The short read of a turn's `promptMeta` a triaging admin needs (model, tools, tokens,
 * retrieval), never the raw object. Billed (`actual*`) token counts win over the estimate when
 * both were recorded. Returns undefined when nothing worth showing was recorded, e.g. a product
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
    inputTokens: usage?.actualInputTokens ?? usage?.inputTokens,
    outputTokens: usage?.actualOutputTokens ?? usage?.outputTokens,
    totalTokens: usage?.actualTotalTokens ?? usage?.totalTokens,
    retrievalOutcome: retrieval?.attempted
      ? (RETRIEVAL_OUTCOME_LABELS[retrieval.outcome ?? ''] ?? 'Ran')
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

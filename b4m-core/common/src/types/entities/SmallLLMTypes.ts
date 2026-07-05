/** Task categories for the Small LLM Service */
export type SmallLLMTaskType =
  | 'classification'
  | 'scoring'
  | 'extraction'
  | 'summarization'
  | 'generation'
  | 'reranking';

/** Request options for SmallLLMService */
export interface SmallLLMOptions {
  /** Temperature override (default: 0 for structured tasks, 0.7 for generation) */
  temperature?: number;
  /** Max tokens for response (default: auto-calculated based on task) */
  maxTokens?: number;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Number of retries on failure (default: 1) */
  retries?: number;
  /** Task type for metrics/logging */
  taskType?: SmallLLMTaskType;
  /** Custom system prompt (overrides built-in prompts for task type) */
  systemPrompt?: string;
}

/** Result with metrics from SmallLLMService */
export interface SmallLLMResponse<T = string> {
  /** The parsed result */
  data: T;
  /** Performance and cost metrics */
  metrics: SmallLLMMetrics;
}

/** Metrics tracked per invocation */
export interface SmallLLMMetrics {
  /** Wall-clock latency in milliseconds */
  latencyMs: number;
  /** Input tokens consumed (if reported by backend) */
  inputTokens?: number;
  /** Output tokens consumed (if reported by backend) */
  outputTokens?: number;
  /** Model ID used */
  modelId: string;
  /** Whether a retry was needed */
  retried: boolean;
  /** Task type label */
  taskType: SmallLLMTaskType;
}

/** Role types accepted by the LLM completion backend */
export type SmallLLMMessageRole = 'user' | 'assistant' | 'system' | 'function' | 'tool';

/**
 * Adapter interface for SmallLLMService.
 * Keeps the service testable with no direct DB or infrastructure access.
 * Call sites resolve the backend via OperationsModelService and pass it in.
 */
export interface SmallLLMAdapters {
  /** The LLM completion backend (provider-agnostic) */
  llm: {
    complete: (
      model: string,
      messages: Array<{ role: SmallLLMMessageRole; content: string }>,
      options: Partial<{
        temperature: number;
        maxTokens: number;
      }>,
      callback: (
        texts: (string | null | undefined)[],
        completionInfo?: { inputTokens?: number; outputTokens?: number }
      ) => Promise<void>
    ) => Promise<void>;
  };
  /** Model ID to pass to the backend */
  modelId: string;
}

/** Fallback configuration for structured completions */
export interface SmallLLMFallback<T> {
  /** Static fallback value to return on failure */
  value: T;
  /** Optional callback when fallback is used */
  onFallback?: (error: Error) => void;
}

/** Re-rank candidate input */
export interface ReRankCandidate {
  id: string;
  snippet: string;
  cosineSimilarity: number;
  /** Optional: keyword match strength (0-1) */
  keywordScore?: number;
}

/** Re-rank result with LLM scoring */
export interface ReRankResult extends ReRankCandidate {
  relevanceScore: number;
  reason: string;
  finalScore: number;
}

/** Configuration for the ReRankService */
export interface ReRankConfig {
  /** Max candidates to send to LLM (default: 30) */
  maxCandidates?: number;
  /** Weight of LLM relevance score vs cosine (default: 0.7) */
  llmWeight?: number;
  /** Minimum LLM score to keep in results (default: 3) */
  minRelevanceScore?: number;
}

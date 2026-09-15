import { z, type ZodSchema } from 'zod';
import type { ILogger } from '@bike4mind/observability';
import type {
  SmallLLMAdapters,
  SmallLLMFallback,
  SmallLLMMessageRole,
  SmallLLMOptions,
  SmallLLMResponse,
  SmallLLMTaskType,
} from '@bike4mind/common';
import { extractJSON, accumulateStream } from './smallLLMHelpers';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 1;

function getDefaultTemperature(taskType?: SmallLLMTaskType): number {
  switch (taskType) {
    case 'classification':
    case 'scoring':
    case 'extraction':
    case 'reranking':
      return 0;
    case 'summarization':
    case 'generation':
    default:
      return 0.7;
  }
}

function getDefaultMaxTokens(taskType?: SmallLLMTaskType): number {
  switch (taskType) {
    case 'classification':
      return 200;
    case 'scoring':
      return 300;
    case 'extraction':
      return 1000;
    case 'summarization':
      return 500;
    case 'reranking':
      return 4000;
    case 'generation':
    default:
      return 800;
  }
}

/**
 * SmallLLMService: Unified abstraction for structured LLM tasks.
 *
 * Wraps ICompletionBackend with:
 * - Non-streaming request/response interface
 * - Automatic JSON parsing + Zod validation
 * - Latency and token metrics tracking
 * - Retry logic with configurable fallbacks
 *
 * Usage:
 *   const { modelId, llm } = await OperationsModelService.getOperationsModel();
 *   const smallLLM = createSmallLLMService({ llm, modelId }, logger);
 *   const { data } = await smallLLM.complete('Summarize this...', { taskType: 'summarization' });
 */
export class SmallLLMService {
  private logger: ILogger;
  private adapters: SmallLLMAdapters;

  constructor(adapters: SmallLLMAdapters, logger?: ILogger) {
    this.adapters = adapters;
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
  }

  /**
   * Simple text completion (non-streaming).
   * Returns the raw text response with metrics.
   */
  async complete(prompt: string, options?: SmallLLMOptions): Promise<SmallLLMResponse<string>> {
    const taskType = options?.taskType || 'generation';
    const temperature = options?.temperature ?? getDefaultTemperature(taskType);
    const maxTokens = options?.maxTokens ?? getDefaultMaxTokens(taskType);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options?.retries ?? DEFAULT_RETRIES;

    const messages: Array<{ role: SmallLLMMessageRole; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    let lastError: Error | undefined;
    let retried = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) retried = true;

        const { text, metrics } = await accumulateStream(
          this.adapters,
          messages,
          { temperature, maxTokens, timeoutMs },
          taskType
        );

        if (!text) {
          throw new Error('SmallLLMService: empty response from LLM');
        }

        return {
          data: text,
          metrics: { ...metrics, retried },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`SmallLLMService: attempt ${attempt + 1} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('SmallLLMService: all attempts failed');
  }

  /**
   * Structured JSON completion with Zod validation.
   * Parses the LLM response as JSON, validates against schema, returns typed result.
   *
   * On failure (after retries), returns the fallback value if provided, otherwise throws.
   */
  async completeJSON<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: SmallLLMOptions,
    fallback?: SmallLLMFallback<T>
  ): Promise<SmallLLMResponse<T>> {
    const taskType = options?.taskType || 'extraction';
    const retries = options?.retries ?? DEFAULT_RETRIES;
    const jsonSystemPrompt = options?.systemPrompt
      ? `${options.systemPrompt}\n\nRespond with valid JSON only. No other text.`
      : 'Respond with valid JSON only. No markdown, no explanation, no other text.';

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { data: rawText, metrics } = await this.complete(prompt, {
          ...options,
          retries: 0, // complete() handles its own retries; we retry the full flow here
          taskType,
          systemPrompt: jsonSystemPrompt,
          temperature: options?.temperature ?? 0,
        });

        const jsonStr = extractJSON(rawText);
        if (!jsonStr) {
          // Log raw response at debug level only to avoid leaking user content/PII
          this.logger.debug('SmallLLMService.completeJSON: no valid JSON found in response', rawText.slice(0, 200));
          throw new Error('SmallLLMService: no valid JSON found in response');
        }

        const parsed = JSON.parse(jsonStr);
        const validated = schema.parse(parsed);

        return {
          data: validated,
          metrics: { ...metrics, retried: metrics.retried || attempt > 0 },
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        if (attempt < retries) {
          this.logger.warn(`SmallLLMService.completeJSON: attempt ${attempt + 1} failed, retrying...`, err.message);
          continue;
        }
      }
    }

    const err = lastError ?? new Error('SmallLLMService.completeJSON: unknown error');

    if (fallback) {
      this.logger.warn('SmallLLMService.completeJSON: using fallback:', err.message);
      try {
        fallback.onFallback?.(err);
      } catch (callbackError) {
        this.logger.warn('SmallLLMService.completeJSON: onFallback callback threw:', callbackError);
      }
      return {
        data: fallback.value,
        metrics: {
          latencyMs: 0,
          modelId: this.adapters.modelId,
          retried: retries > 0,
          taskType,
        },
      };
    }

    throw err;
  }

  /**
   * Classification helper - returns one of the provided categories.
   */
  async classify<C extends string>(
    input: string,
    categories: readonly C[],
    context?: string,
    options?: SmallLLMOptions
  ): Promise<SmallLLMResponse<C>> {
    if (categories.length === 0) {
      throw new Error('SmallLLMService.classify: categories array must not be empty');
    }
    const categoryList = categories.map((c, i) => `${i + 1}. "${c}"`).join('\n');
    const contextSection = context ? `\nContext: ${context}` : '';

    const prompt = `Classify the following input into exactly one of these categories:\n${categoryList}${contextSection}\n\nInput: "${input}"\n\nRespond with JSON: { "category": "<chosen category>", "confidence": <0.0-1.0> }`;

    const schema = z.object({
      category: z.enum(categories as unknown as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });

    const { data, metrics } = await this.completeJSON(prompt, schema, {
      ...options,
      taskType: 'classification',
      maxTokens: options?.maxTokens ?? 100,
    });

    return { data: data.category as C, metrics };
  }

  /**
   * Scoring helper - scores input on a numeric scale.
   */
  async score(
    input: string,
    criteria: string,
    scale: [number, number] = [0, 10],
    options?: SmallLLMOptions
  ): Promise<SmallLLMResponse<{ score: number; reason: string }>> {
    const prompt = `Score the following input on a scale of ${scale[0]} to ${scale[1]}.\n\nCriteria: ${criteria}\n\nInput: "${input}"\n\nRespond with JSON: { "score": <number>, "reason": "<brief explanation>" }`;

    const schema = z.object({
      score: z.number().min(scale[0]).max(scale[1]),
      reason: z.string(),
    });

    return this.completeJSON(prompt, schema, {
      ...options,
      taskType: 'scoring',
      maxTokens: options?.maxTokens ?? 200,
    });
  }

  /**
   * Batch scoring - scores multiple items against a query in a single LLM call.
   * Optimized for re-ranking: sends all items at once rather than one-by-one.
   */
  async scoreBatch(
    query: string,
    items: Array<{ id: string; text: string }>,
    criteria: string,
    options?: SmallLLMOptions
  ): Promise<SmallLLMResponse<Array<{ id: string; score: number; reason: string }>>> {
    if (!items.length) {
      return {
        data: [],
        metrics: {
          latencyMs: 0,
          modelId: this.adapters.modelId,
          retried: false,
          taskType: options?.taskType ?? 'reranking',
        },
      };
    }

    const itemList = items.map((item, i) => `[${i + 1}] (id: "${item.id}") "${item.text}"`).join('\n');

    const prompt = `Score each of the following items on a scale of 0 to 10.\n\nQuery: "${query}"\nCriteria: ${criteria}\n\nItems:\n${itemList}\n\nRespond with a JSON array of objects in the same order, each with: { "id": "<item id>", "score": <0-10>, "reason": "<brief 5-15 word explanation>" }`;

    const schema = z.array(
      z.object({
        id: z.string(),
        score: z.number().min(0).max(10),
        reason: z.string(),
      })
    );

    return this.completeJSON(prompt, schema, {
      ...options,
      taskType: options?.taskType || 'reranking',
      maxTokens: options?.maxTokens ?? Math.min(items.length * 80, 4000),
    });
  }

  /**
   * Expand a search query by correcting spelling and adding synonyms.
   *
   * Takes a raw user query and returns:
   * - corrected: The query with spelling fixed
   * - keywords: Expanded list of search terms including synonyms
   *
   * Example:
   *   Input: "consciouness in AI"
   *   Output: {
   *     corrected: "consciousness in AI",
   *     keywords: ["consciousness", "AI", "artificial intelligence", "awareness", "sentience"]
   *   }
   */
  async expandQuery(
    query: string,
    options?: SmallLLMOptions
  ): Promise<SmallLLMResponse<{ corrected: string; keywords: string[] }>> {
    const prompt = `You are a search query optimizer. Given a user's search query:

1. Fix any spelling errors
2. Extract the key search terms
3. Add 2-4 relevant synonyms or related terms that would help find relevant content

User query: "${query}"

Respond with JSON only:
{
  "corrected": "<the query with spelling fixed>",
  "keywords": ["<original terms>", "<synonyms>", "<related terms>"]
}

Keep keywords concise (1-2 words each). Include the original terms (corrected) plus synonyms.`;

    const schema = z.object({
      corrected: z.string(),
      keywords: z.array(z.string()),
    });

    return this.completeJSON(prompt, schema, {
      ...options,
      taskType: 'extraction',
      temperature: 0,
      maxTokens: 200,
      timeoutMs: options?.timeoutMs ?? 5000,
    });
  }
}

/**
 * Factory function that creates a SmallLLMService from pre-resolved adapters.
 *
 * Usage:
 *   const { modelId, llm } = await OperationsModelService.getOperationsModel();
 *   const smallLLM = createSmallLLMService({ llm, modelId }, req.logger);
 */
export function createSmallLLMService(adapters: SmallLLMAdapters, logger?: ILogger): SmallLLMService {
  return new SmallLLMService(adapters, logger);
}

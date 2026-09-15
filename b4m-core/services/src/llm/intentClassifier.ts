import { z } from 'zod';
import type { Logger } from '@bike4mind/observability';
import type { IntentClassifierConfig, ModelInfo, ResponseFormat } from '@bike4mind/common';
import { IntentClassifierConfigSchema } from '@bike4mind/common';
import { type ApiKeyTable, type ICompletionBackend, getLlmByModel } from '@bike4mind/llm-adapters';
import {
  buildIntentSystemPrompt,
  buildIntentUserPrompt,
  INTENT_DECISION_JSON_SCHEMA,
  type IntentPromptContext,
} from './intentClassifier.prompt';
import { extractJSON } from './smallLLMHelpers';
import { type IntentClassifierCache, getSharedIntentCache } from './intentClassifier.cache';

const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TEMPERATURE = 0;
/**
 * Per-attempt timeouts are staggered so worst-case cascade wall time stays
 * well inside the frontend Lambda's API-gateway budget (typically 30s). With
 * 5s primary + 3s x 2 fallbacks the bound is ~11s even if every backend
 * stalls - and the primary still has enough headroom for Haiku's full
 * tool-use round-trip.
 */
const PRIMARY_TIMEOUT_MS = 5000;
const FALLBACK_TIMEOUT_MS = 3000;
/**
 * Grace window after `useAgent` first resolves in the stream. Aborting the
 * INSTANT we see `useAgent` saves latency but loses `confidence` / `reason` /
 * `signals` - Anthropic tool-use mode streams fields in declared order so
 * `useAgent` arrives first and the trailing three fields land progressively.
 *
 * 500ms is calibrated against observed Haiku latencies (~700-900ms total for
 * non-complex queries): the grace lets the closing `"` of `reason` and `]` of
 * `signals` stream in for the common case while bounding worst-case latency
 * at +500ms over the earliest `useAgent` signal. The fast path - full JSON
 * parseable before the deadline - still aborts immediately, so this only
 * costs latency when later fields are slow.
 *
 * Production e2e against the PR preview showed that 150ms captured `confidence`
 * (the regex matches as soon as digits stream) but reliably dropped `reason`
 * and `signals` into partial-parse defaults; 500ms recovers both.
 */
const EARLY_EXIT_GRACE_MS = 500;
/** Best-effort backends sometimes emit prose around the JSON; one retry with a stricter ask is enough. */
const BEST_EFFORT_RETRIES = 1;

export const IntentDecisionSchema = z.object({
  useAgent: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  signals: z.array(z.string()),
});

export type IntentDecisionPayload = z.infer<typeof IntentDecisionSchema>;

export interface IntentDecision extends IntentDecisionPayload {
  /** Model id that produced the decision (after cascade resolution). */
  classifierModel: string;
  /** End-to-end latency including cascade attempts. */
  latencyMs: number;
  /** True when the result was served from the per-user LRU cache. */
  cacheHit: boolean;
  /** How the backend honored `responseFormat` (see ICompletionBackend docs). */
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  /** True when the streaming parser aborted after `useAgent` resolved. */
  earlyExited: boolean;
}

export interface IntentClassifierInput extends IntentPromptContext {
  /** Authenticated user id - namespaces the cache. */
  userId: string;
}

export interface IntentClassifierAdapters {
  apiKeyTable: ApiKeyTable;
  availableModels: ModelInfo[];
  logger: Logger;
  /** Admin orchestration sub-config. Defaults applied if omitted. */
  config?: IntentClassifierConfig;
  /** Per-process cache. Defaults to the shared lambda-warm singleton. */
  cache?: IntentClassifierCache<IntentDecision>;
  /**
   * Test seam - override the cascade resolution. Production code resolves
   * `[config.primaryModel, ...config.fallbackModels]`.
   */
  resolveCascade?: () => string[];
}

class CascadeExhaustedError extends Error {
  constructor(public readonly attempts: Array<{ modelId: string; error: string }>) {
    super(`intentClassifier: cascade exhausted (${attempts.length} attempts)`);
  }
}

/**
 * Multi-provider LLM intent classifier.
 *
 * Decides whether a user message should route to the ReAct agent loop
 * (`useAgent: true`) or stay on the standard chat completion path. Designed
 * to dark-launch - the M3 endpoint returns a decision but no client wires
 * it into routing until M4.
 *
 * Latency budget: ~200-300ms p50 on Haiku via streaming early-exit, with the
 * remaining cascade (Gemini Flash Lite -> GPT-4.1-nano) as resilience for
 * provider outages.
 */
export async function classifyIntent(
  input: IntentClassifierInput,
  adapters: IntentClassifierAdapters
): Promise<IntentDecision> {
  const startedAt = Date.now();
  const config = adapters.config ?? IntentClassifierConfigSchema.parse({});
  const cache = adapters.cache ?? getSharedIntentCache<IntentDecision>();
  const cacheKey = {
    userId: input.userId,
    message: input.message,
    hasFileAttachments: input.hasFileAttachments,
    hasAgentMention: input.hasAgentMention,
  };

  const cached = cache.get(cacheKey);
  if (cached) {
    // `responseFormatMode` + `earlyExited` describe the original underlying
    // call - they're meaningless for a served-from-cache response and would
    // poison "% best-effort" / "% early-exited" dashboards if propagated.
    return {
      ...cached,
      cacheHit: true,
      latencyMs: Date.now() - startedAt,
      responseFormatMode: undefined,
      earlyExited: false,
    };
  }

  const cascade = adapters.resolveCascade ? adapters.resolveCascade() : [config.primaryModel, ...config.fallbackModels];

  if (cascade.length === 0) {
    throw new Error('intentClassifier: cascade is empty — check primaryModel/fallbackModels config');
  }

  const attempts: Array<{ modelId: string; error: string }> = [];

  for (let i = 0; i < cascade.length; i++) {
    const modelId = cascade[i];
    const timeoutMs = i === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;
    const modelInfo = adapters.availableModels.find(m => m.id === modelId);
    if (!modelInfo) {
      attempts.push({ modelId, error: 'not in availableModels' });
      adapters.logger.warn(`[intentClassifier] skipping ${modelId}: not in availableModels`);
      continue;
    }

    let backend: ICompletionBackend | null;
    try {
      backend = getLlmByModel(adapters.apiKeyTable, {
        modelInfo,
        logger: adapters.logger,
        endUserId: input.userId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ modelId, error: `getLlmByModel threw: ${msg}` });
      adapters.logger.warn(`[intentClassifier] ${modelId} backend init failed: ${msg}`);
      continue;
    }

    if (!backend) {
      attempts.push({ modelId, error: 'no api key for backend' });
      adapters.logger.info(`[intentClassifier] skipping ${modelId}: no api key for ${modelInfo.backend}`);
      continue;
    }

    try {
      const decision = await classifyWithBackend(backend, modelInfo, input, adapters.logger, timeoutMs);
      cache.set(cacheKey, decision);
      return { ...decision, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ modelId, error: msg });
      adapters.logger.warn(`[intentClassifier] ${modelId} failed: ${msg}`);
    }
  }

  throw new CascadeExhaustedError(attempts);
}

async function classifyWithBackend(
  backend: ICompletionBackend,
  modelInfo: ModelInfo,
  input: IntentClassifierInput,
  logger: Logger,
  timeoutMs: number
): Promise<IntentDecision> {
  const responseFormat: ResponseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'IntentDecision',
      description: 'Routing decision for the universal agent-mode auto-router.',
      schema: INTENT_DECISION_JSON_SCHEMA as unknown as Record<string, unknown>,
      strict: true,
    },
  };

  const baseMessages = [
    { role: 'system' as const, content: buildIntentSystemPrompt() },
    { role: 'user' as const, content: buildIntentUserPrompt(input) },
  ];

  let attemptResult = await runOnce(backend, modelInfo, baseMessages, responseFormat, logger, timeoutMs);

  // Best-effort backends (Gemini, Bedrock, xAI, Ollama) can return prose-wrapped
  // or schema-violating JSON. One stricter retry catches the common case.
  let retries = 0;
  while (
    attemptResult.responseFormatMode === 'best-effort' &&
    attemptResult.validation?.success !== true &&
    retries < BEST_EFFORT_RETRIES
  ) {
    retries += 1;
    logger.warn(
      `[intentClassifier] ${modelInfo.id} best-effort validation failed; retry ${retries}/${BEST_EFFORT_RETRIES}`
    );
    const stricterMessages = [
      ...baseMessages,
      {
        role: 'system' as const,
        content:
          'Your previous response was not valid JSON matching the schema. Respond with ONLY the JSON object, starting with `{"useAgent":` — no prose, no markdown fences.',
      },
    ];
    attemptResult = await runOnce(backend, modelInfo, stricterMessages, responseFormat, logger, timeoutMs);
  }

  const validation = attemptResult.validation;
  if (!validation || !validation.success) {
    const errMsg = validation && !validation.success ? validation.error : 'unknown';
    throw new Error(`intentClassifier: response validation failed for ${modelInfo.id}: ${errMsg}`);
  }

  return {
    ...validation.data,
    classifierModel: modelInfo.id,
    latencyMs: attemptResult.latencyMs,
    cacheHit: false,
    responseFormatMode: attemptResult.responseFormatMode,
    earlyExited: attemptResult.earlyExited,
  };
}

interface RunResult {
  accumulated: string;
  latencyMs: number;
  earlyExited: boolean;
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  validation: { success: true; data: IntentDecisionPayload } | { success: false; error: string } | undefined;
}

async function runOnce(
  backend: ICompletionBackend,
  modelInfo: ModelInfo,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  responseFormat: ResponseFormat,
  logger: Logger,
  timeoutMs: number
): Promise<RunResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let accumulated = '';
  let earlyExited = false;
  let responseFormatMode: RunResult['responseFormatMode'];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const triggerEarlyExit = () => {
    if (earlyExited) return;
    earlyExited = true;
    controller.abort();
  };

  const completionPromise = backend.complete(
    modelInfo.id,
    messages,
    {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      stream: true,
      responseFormat,
      abortSignal: controller.signal,
    },
    async (chunks, completionInfo) => {
      for (const chunk of chunks) {
        if (chunk != null) accumulated += chunk;
      }
      if (completionInfo?.responseFormatMode) {
        responseFormatMode = completionInfo.responseFormatMode;
      }
      // Streaming early-exit with a small grace window:
      //  - If the full JSON is already parseable, abort immediately (fast path).
      //  - Otherwise, once `useAgent` resolves, schedule the abort
      //    EARLY_EXIT_GRACE_MS later - that gives Anthropic tool-use enough
      //    time to emit the trailing confidence/reason/signals fields in the
      //    common case while still bounding worst-case latency.
      //  - If the trailing fields arrive before the timer fires, abort then.
      // Backends that don't honor abortSignal just stream to completion.
      if (earlyExited) return;
      if (hasResolvedUseAgent(accumulated)) {
        if (extractJSON(accumulated)) {
          if (graceTimer) clearTimeout(graceTimer);
          triggerEarlyExit();
        } else if (!graceTimer) {
          graceTimer = setTimeout(triggerEarlyExit, EARLY_EXIT_GRACE_MS);
          graceTimer.unref?.();
        }
      }
    }
  );

  // Hold the timer handle so we can clearTimeout on success. `.unref?.()`
  // alone prevents the timer from keeping the process alive but doesn't free
  // the closure - at sustained Lambda volume the unfired-but-pinned timers
  // add up.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`intentClassifier: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([completionPromise, timeoutPromise]);
  } catch (err) {
    // Self-aborts from the early-exit path are expected - swallow only those.
    if (!earlyExited) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[intentClassifier] completion threw (early-exit=${earlyExited}): ${msg}`);
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }

  return {
    accumulated,
    latencyMs: Date.now() - startedAt,
    earlyExited,
    responseFormatMode,
    validation: validateDecision(accumulated),
  };
}

/**
 * Detect that the streaming output has resolved `"useAgent": <bool>`. The
 * prompt + few-shots guarantee this field appears first, so the regex is a
 * cheap-enough check per chunk.
 */
function hasResolvedUseAgent(text: string): boolean {
  return /"useAgent"\s*:\s*(true|false)\b/.test(text);
}

function validateDecision(text: string): RunResult['validation'] {
  if (!text.trim()) return { success: false, error: 'empty response' };

  const fullJson = extractJSON(text);
  if (fullJson) {
    try {
      const parsed = JSON.parse(fullJson);
      const result = IntentDecisionSchema.safeParse(parsed);
      if (result.success) return { success: true, data: result.data };
    } catch {
      // Fall through to partial-parse path for early-exited streams.
    }
  }

  // Partial-parse path for early-exited streams. We may have only the
  // `useAgent` boolean before the abort landed; fill in sensible defaults
  // so the routing decision is preserved even when the full schema isn't.
  const partial = extractPartialDecision(text);
  if (partial) {
    const result = IntentDecisionSchema.safeParse(partial);
    if (result.success) return { success: true, data: result.data };
    return { success: false, error: `partial parse failed schema: ${result.error.message}` };
  }

  return { success: false, error: 'no parseable useAgent field' };
}

function extractPartialDecision(text: string): IntentDecisionPayload | null {
  const useAgentMatch = text.match(/"useAgent"\s*:\s*(true|false)/);
  if (!useAgentMatch) return null;
  const confMatch = text.match(/"confidence"\s*:\s*([0-9]*\.?[0-9]+)/);
  const reasonMatch = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const signalsMatch = text.match(/"signals"\s*:\s*\[((?:[^\]\\]|\\.)*)\]/);

  let signals: string[] = [];
  if (signalsMatch) {
    try {
      signals = JSON.parse(`[${signalsMatch[1]}]`);
      if (!Array.isArray(signals)) signals = [];
    } catch {
      signals = [];
    }
  }

  return {
    useAgent: useAgentMatch[1] === 'true',
    confidence: confMatch ? clamp01(Number(confMatch[1])) : 0.5,
    reason: reasonMatch ? unescapeJsonString(reasonMatch[1]) : 'streaming early-exit',
    signals,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

export { CascadeExhaustedError };

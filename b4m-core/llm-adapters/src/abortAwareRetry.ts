import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { isRetryableError } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from './backend';

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function getAbortAwareRetrySignal(
  { retryMode, abortSignal, stream, tools, responseFormat, _internal }: Partial<ICompletionOptions>,
  singleAttemptSupported = false
): AbortSignal | undefined {
  if (retryMode !== 'abort-aware' && retryMode !== 'single-attempt') return undefined;
  if (retryMode === 'single-attempt' && !singleAttemptSupported)
    throw new Error('Single-attempt completion is unsupported by this adapter');
  if (!abortSignal) throw new Error('Abort-aware completion retries require an abort signal');
  abortSignal.throwIfAborted();
  const hasTools = Array.isArray(tools) ? tools.length > 0 : tools !== undefined;
  if (stream !== false || hasTools || responseFormat?.type === 'json_schema' || _internal?.evaluation) {
    throw new Error(
      'Abort-aware completion retries require a non-streaming text call without tools, structured output, or evaluation'
    );
  }
  return abortSignal;
}

function getErrorField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function getErrorHeader(error: unknown, name: string): string | undefined {
  const headers =
    getErrorField(error, 'headers') ??
    getErrorField(getErrorField(error, 'response'), 'headers') ??
    getErrorField(getErrorField(error, '$response'), 'headers');
  const get = getErrorField(headers, 'get');
  const value: unknown =
    typeof get === 'function'
      ? get.call(headers, name)
      : headers && typeof headers === 'object'
        ? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
        : undefined;
  return typeof value === 'string' ? value : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const milliseconds = getErrorHeader(error, 'retry-after-ms');
  if (milliseconds?.trim()) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const retryAfter = getErrorHeader(error, 'retry-after');
  if (!retryAfter?.trim()) return undefined;
  const numericSeconds = Number(retryAfter);
  const delay = Number.isFinite(numericSeconds) ? numericSeconds * 1_000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function defaultIsRetryable(error: unknown): boolean {
  const status = getErrorField(error, 'status') ?? getErrorField(getErrorField(error, '$metadata'), 'httpStatusCode');
  if (typeof status === 'number') {
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
  }
  if (error instanceof OpenAIUserAbortError || error instanceof AnthropicUserAbortError) return false;
  if (error instanceof OpenAIConnectionTimeoutError || error instanceof AnthropicConnectionTimeoutError) return true;
  if (error instanceof OpenAIConnectionError || error instanceof AnthropicConnectionError) {
    const cause: unknown = error.cause;
    return cause instanceof Error && isRetryableError(cause);
  }
  return error instanceof Error && isRetryableError(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryAbortAware<T>(
  dispatch: () => PromiseLike<T>,
  signal: AbortSignal,
  {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    isRetryable = defaultIsRetryable,
    onRetry,
  }: {
    maxAttempts?: number;
    isRetryable?: (error: unknown) => boolean;
    onRetry?: (event: { error: Error; delayMs: number }) => void;
  } = {}
): Promise<T> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('Invalid retry attempt limit');
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await dispatch();
    } catch (error) {
      if (signal.aborted || attempt >= maxAttempts) throw error;
      const hint = getErrorHeader(error, 'x-should-retry');
      if (hint === 'false' || (hint !== 'true' && !isRetryable(error))) throw error;

      const localDelayMs = 500 * 2 ** (attempt - 1);
      const delayMs = retryAfterMs(error) ?? Math.round(localDelayMs * (0.75 + 0.5 * Math.random()));
      const deadline = Date.now() + delayMs;
      try {
        onRetry?.({ error: error instanceof Error ? error : new Error(String(error)), delayMs });
      } catch {
        // A telemetry observer must not interrupt provider retries.
      }
      let remaining: number;
      while ((remaining = deadline - Date.now()) > 0) {
        await sleep(Math.min(Math.ceil(remaining), MAX_TIMER_DELAY_MS), signal);
      }
    }
  }
}

export async function reportUsageOnAbort(
  signal: AbortSignal,
  callback: (text: [], info: CompletionInfo) => Promise<void>,
  usage?: CompletionInfo
): Promise<void> {
  if (!signal.aborted) return;
  try {
    if (usage) await callback([], usage);
  } finally {
    signal.throwIfAborted();
  }
}

export function assertMeasuredProviderUsage(usage: {
  inputTokens: unknown;
  outputTokens: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  cacheWrite1hInputTokens?: unknown;
}): void {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined)
    throw new Error('Provider response omitted measured usage');
  for (const quantity of Object.values(usage)) {
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || (quantity as number) < 0))
      throw new Error('Provider response contained invalid measured usage');
  }
  if (((usage.cacheWrite1hInputTokens as number) ?? 0) > ((usage.cacheCreationInputTokens as number) ?? 0))
    throw new Error('Provider response contained invalid measured cache usage');
}

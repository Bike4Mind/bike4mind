import type { Logger } from '@bike4mind/observability';
import { LlmTimeoutError } from './llmTimeoutErrors';

const MAX_TRANSPORT_RETRIES = 2;

/** undici's default headersTimeout, which an SDK on Node's global fetch (Gemini) inherits. */
const UNDICI_HEADERS_TIMEOUT_MS = 300_000;

/** undici surfaces a dropped or never-established connection as a bare TypeError. */
export function isTransportError(err: unknown): boolean {
  return err instanceof TypeError && (err.message === 'terminated' || err.message === 'fetch failed');
}

/** The provider accepted the request but sent no response headers before undici gave up. */
export function isHeadersTimeoutError(err: unknown): boolean {
  if (!(err instanceof TypeError) || typeof err.cause !== 'object' || err.cause === null) return false;
  return 'code' in err.cause && err.cause.code === 'UND_ERR_HEADERS_TIMEOUT';
}

/**
 * Retry `open` on a transient transport failure. Only for the call that opens a request: once a
 * stream has started yielding, a retry would replay output the caller already consumed.
 */
export async function retryTransportErrors<T>(
  open: () => Promise<T>,
  { logger, label, abortSignal }: { logger: Logger; label: string; abortSignal?: AbortSignal }
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await open();
    } catch (err) {
      // Not transient: the model sat silent for the whole timeout, and each reopen waits it out
      // again. Typed so the completion loop applies its own request-timeout retry and fallback.
      if (isHeadersTimeoutError(err)) throw headersTimeoutError(label, logger);
      if (!isTransportError(err) || attempt >= MAX_TRANSPORT_RETRIES || abortSignal?.aborted) throw err;
      logger.warn(
        `[${label}] Transport error "${(err as Error).message}", retry ${attempt + 1}/${MAX_TRANSPORT_RETRIES}`
      );
      await sleepUnlessAborted(100 * 2 ** attempt, abortSignal);
      if (abortSignal?.aborted) throw err;
    }
  }
}

function headersTimeoutError(label: string, logger: Logger): LlmTimeoutError {
  const seconds = UNDICI_HEADERS_TIMEOUT_MS / 1000;
  // WARN, not error: an expected, recoverable timeout; ChatCompletionProcess logs it at debug.
  logger.warn(`[${label}] Request timeout - no response headers within ${seconds}s`);
  return new LlmTimeoutError(
    'request',
    UNDICI_HEADERS_TIMEOUT_MS,
    `${label} request timeout - no response headers received within ${seconds} seconds. The model is responding slowly.`
  );
}

function sleepUnlessAborted(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abortSignal?.addEventListener('abort', done, { once: true });
  });
}

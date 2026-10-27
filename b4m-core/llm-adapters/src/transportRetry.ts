import type { Logger } from '@bike4mind/observability';

const MAX_TRANSPORT_RETRIES = 2;

/** undici surfaces a dropped or never-established connection as a bare TypeError. */
export function isTransportError(err: unknown): boolean {
  return err instanceof TypeError && (err.message === 'terminated' || err.message === 'fetch failed');
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
      if (!isTransportError(err) || attempt >= MAX_TRANSPORT_RETRIES || abortSignal?.aborted) throw err;
      logger.warn(
        `[${label}] Transport error "${(err as Error).message}", retry ${attempt + 1}/${MAX_TRANSPORT_RETRIES}`
      );
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

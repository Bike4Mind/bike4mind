const DEFAULT_MAX_RETRIES = 2;

export const defaultRetryDelayMs = (retry: number): number => 500 * 2 ** retry * (1 - Math.random() * 0.25);

const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export type FetchRetryOptions = {
  signal?: AbortSignal;
  attemptTimeoutMs: number;
  retryDelayMs?: (retry: number) => number;
  maxRetries?: number;
};

/** POST-style fetch that retries network errors and 408/429/5xx with backoff; any other response is returned. */
export async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  { signal, attemptTimeoutMs, retryDelayMs = defaultRetryDelayMs, maxRetries = DEFAULT_MAX_RETRIES }: FetchRetryOptions
): Promise<Response> {
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted();
    const signals = [AbortSignal.timeout(attemptTimeoutMs), ...(signal ? [signal] : [])];
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (error) {
      if (signal?.aborted || retry >= maxRetries) throw error;
    }
    if (response && (!isRetryableStatus(response.status) || retry >= maxRetries)) return response;
    // Drain rather than cancel so the connection is reusable.
    await response?.arrayBuffer().catch(() => undefined);
    await sleep(retryDelayMs(retry), signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    // Detach on resolve too: the caller's signal can outlive many sleeps, and each would otherwise keep a listener.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

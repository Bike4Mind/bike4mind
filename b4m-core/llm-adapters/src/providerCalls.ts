/**
 * What an adapter records about the provider requests it makes for one completion, so a caller
 * diagnosing a failure can say which request and which attempt it was. Shared by reference
 * through ICompletionOptions.providerCalls, so tool-loop recursion keeps writing to one object.
 */
export interface ProviderCallStats {
  /** The provider family, set by the caller that picked the backend. */
  provider?: string;
  /** Provider requests opened so far in this completion; each tool round opens one. */
  requests: number;
  /** Attempts the latest request has made, 1 when its first try is the one in play. */
  attempts: number;
}

export function createProviderCallStats(provider?: string): ProviderCallStats {
  return { ...(provider ? { provider } : {}), requests: 0, attempts: 0 };
}

/**
 * Wrap the function an adapter hands to withRetry so each try is counted. Counting inside the
 * function rather than reading withRetry's result is what keeps the count right when every
 * try fails and there is no result to read.
 */
export function countProviderAttempts<T>(
  stats: ProviderCallStats | undefined,
  call: () => Promise<T>
): () => Promise<T> {
  if (!stats) return call;
  stats.requests++;
  stats.attempts = 0;
  return () => {
    stats.attempts++;
    return call();
  };
}

/** For an AWS SDK call, whose own retry loop reports its attempts on `$metadata`. */
export function recordAwsProviderCall(stats: ProviderCallStats | undefined, outcome: unknown): void {
  if (!stats) return;
  stats.requests++;
  const attempts = (outcome as { $metadata?: { attempts?: unknown } } | undefined)?.$metadata?.attempts;
  stats.attempts = typeof attempts === 'number' ? attempts : 1;
}

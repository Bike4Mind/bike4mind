import {
  classifyProviderFailure,
  toCompletionErrorCause,
  type CompletionErrorCause,
  type CompletionInfo,
  type ProviderFailure,
} from '@bike4mind/common';
import type { ProviderCallStats } from '@bike4mind/llm-adapters';

/**
 * What the completions route saw of one provider stream, kept as plain counters so the success
 * path pays a few assignments per chunk and nothing else. Read once, when the request fails.
 *
 * Chunks are the callbacks the adapter makes, not raw network reads: an adapter that buffers a
 * tool call's argument deltas reports them as one chunk. Times are ms since the request reached
 * the handler.
 */
export function createStreamStats(now: () => number = Date.now) {
  const receivedAt = now();
  let completionStartedAt: number | undefined;
  let firstChunkAt: number | undefined;
  let lastChunkAt: number | undefined;
  let chunks = 0;
  let chars = 0;
  let visibleTextSent = false;

  return {
    completionStarted(): void {
      completionStartedAt = now();
    },
    chunk(text: (string | null | undefined)[], info?: CompletionInfo): void {
      const at = now();
      chunks++;
      firstChunkAt ??= at;
      lastChunkAt = at;
      const content = text[1] || text[0];
      if (!content) return;
      chars += content.length;
      if (info?.channel !== 'reasoning') visibleTextSent = true;
    },
    snapshot() {
      const at = now();
      const callStartedAt = completionStartedAt ?? receivedAt;
      return {
        elapsedMs: at - receivedAt,
        ...(firstChunkAt !== undefined ? { timeToFirstChunkMs: firstChunkAt - callStartedAt } : {}),
        idleMs: at - (lastChunkAt ?? callStartedAt),
        chunks,
        chars,
        visibleTextSent,
      };
    },
  };
}

export type StreamStats = ReturnType<typeof createStreamStats>;
export type StreamStatsSnapshot = ReturnType<StreamStats['snapshot']>;

export interface StreamFailure {
  failure: ProviderFailure;
  stream: StreamStatsSnapshot;
  /** The wire-safe detail for the error frame; absent when there is nothing to classify. */
  cause?: CompletionErrorCause;
}

export function classifyStreamFailure(
  error: unknown,
  stats: StreamStats,
  { clientAborted }: { clientAborted: boolean }
): StreamFailure {
  const failure = classifyProviderFailure(error, { clientAborted });
  const stream = stats.snapshot();
  const cause = toCompletionErrorCause(failure, { elapsedMs: stream.elapsedMs, idleMs: stream.idleMs });
  return { failure, stream, ...(cause ? { cause } : {}) };
}

/**
 * The fields the `[CLI_LLM] Handler error` entry adds for someone diagnosing a failed stream.
 * The cause chain may hold upstream text, so this goes to server logs only, never to a client.
 */
export function streamFailureLogFields(
  { failure, stream }: StreamFailure,
  model: string | undefined,
  calls: ProviderCallStats
): Record<string, unknown> {
  return {
    provider: calls.provider,
    model,
    failureKind: failure.kind ?? 'unclassified',
    ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {}),
    providerRequests: calls.requests,
    attempt: failure.sdkAttempts ?? calls.attempts,
    ...stream,
    causeChain: failure.chain,
  };
}

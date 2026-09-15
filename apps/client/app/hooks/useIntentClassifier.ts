import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Hard client-side latency budget for the classifier round-trip.
 *
 * Anything slower than this falls through to the rule-based router so the
 * Layer-1 dogfooding cohort never feels the classifier as a perceived
 * regression. Tuned against the M3 streaming early-exit p50 (~200-300ms on
 * Haiku) - see `b4m-core/services/src/llm/intentClassifier.ts`.
 */
export const CLASSIFIER_TIMEOUT_MS = 400;

/**
 * Mirror of `IntentDecision` from `@bike4mind/services` - defined locally so
 * the client doesn't pull the services package (and its transitive
 * server-only deps) into the browser bundle. Keep in sync with
 * `b4m-core/services/src/llm/intentClassifier.ts`.
 */
export interface IntentDecision {
  useAgent: boolean;
  confidence: number;
  reason: string;
  signals: string[];
  classifierModel: string;
  latencyMs: number;
  cacheHit: boolean;
  earlyExited: boolean;
}

export interface ClassifyIntentInput {
  /**
   * Namespaces the React Query cache key so user A's classifier decisions
   * are never served to user B inside the same SPA session (the QueryClient
   * lives for the lifetime of the tab; without this, a sign-out -> sign-in
   * without a hard reload would cross-leak). The server keeps a parallel
   * per-user LRU as the second tier.
   */
  userId: string;
  message: string;
  hasFileAttachments?: boolean;
  hasAgentMention?: boolean;
}

export type ClassifyIntentOutcome =
  | { status: 'decided'; decision: IntentDecision; shadowMode?: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

interface ClassifyIntentResponse {
  decision?: IntentDecision;
  shadowMode?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * React Query-backed wrapper for `POST /api/ai/classify-intent`.
 *
 * `classify()` returns within `CLASSIFIER_TIMEOUT_MS` or yields `{ status:
 * 'timeout' }`, in which case the caller falls through to the rule-based
 * router. The hook deduplicates concurrent identical requests and serves
 * subsequent calls in the same hour from React Query's cache; the server
 * keeps its own per-user LRU as a second tier (see
 * `b4m-core/services/src/llm/intentClassifier.cache.ts`).
 */
export function useIntentClassifier() {
  const queryClient = useQueryClient();

  return useCallback(
    async (input: ClassifyIntentInput): Promise<ClassifyIntentOutcome> => {
      const queryKey = [
        'intent-classification',
        input.userId,
        input.message,
        input.hasFileAttachments ?? false,
        input.hasAgentMention ?? false,
      ] as const;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

      try {
        const data = await queryClient.fetchQuery<ClassifyIntentResponse>({
          queryKey,
          staleTime: CACHE_TTL_MS,
          gcTime: CACHE_TTL_MS,
          retry: false,
          queryFn: async ({ signal }) => {
            // Combine React Query's per-call AbortSignal with our latency-budget
            // signal so either trigger cancels the fetch cleanly.
            const merged = mergeSignals(signal, controller.signal);
            // Strip `userId` from the body - the server identifies the user
            // from the auth token; the field exists purely to namespace the
            // client-side cache key.
            const { userId: _userId, ...body } = input;
            const res = await fetch('/api/ai/classify-intent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: merged,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => res.statusText);
              throw new Error(`classify-intent ${res.status}: ${text}`);
            }
            return (await res.json()) as ClassifyIntentResponse;
          },
        });

        if (data.skipped) {
          return { status: 'skipped', reason: data.reason ?? 'unknown' };
        }
        if (!data.decision) {
          return { status: 'error', message: 'classifier returned no decision' };
        }
        return { status: 'decided', decision: data.decision, shadowMode: data.shadowMode };
      } catch (err) {
        if (controller.signal.aborted) return { status: 'timeout' };
        if (err instanceof Error && err.name === 'AbortError') return { status: 'timeout' };
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', message: msg };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    [queryClient]
  );
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return merged.signal;
}

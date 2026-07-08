import { Resource } from 'sst';
import type { z } from 'zod';
import type { QuestStartBodySchema } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';

type QuestStartBody = z.infer<typeof QuestStartBodySchema>;

// The frontend only blocks on the 202 ACK, not on processing. Keep this short - a slow/
// unreachable service should fail fast so the caller can surface an error rather than hang.
// This is the overall budget across all attempts (including the retry + backoff).
const DISPATCH_TIMEOUT_MS = 10_000;
// One retry. Fargate task replacement / rolling deploy makes the service briefly
// unreachable; a single retry rides over that blip instead of surfacing a user-facing error.
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 300;

/**
 * Hand a created quest to the always-on ChatCompletion for processing.
 *
 * Replaces the old `LLMEvents.CompletionStart.publish()` (EventBridge -> Lambda) path.
 * POSTs the QuestStartBody to the service's VPC-internal load balancer; the service ACKs
 * with 202 in milliseconds and processes the quest in-process, streaming results over the
 * existing WebSocket path. No cold start, no Lambda timeout.
 *
 * Retries once on transient failures (5xx, connection error, abort/timeout) within the
 * overall DISPATCH_TIMEOUT_MS budget. Does NOT retry deterministic 4xx (401 auth / 400
 * validation) - retrying those just burns the budget.
 *
 * Single path for every environment: hosted resolves `Resource.ChatCompletion.url`
 * from the SST link; self-host resolves it from the `@bike4mind/resource` shim (env
 * `CHAT_COMPLETION`, pointing at the `chatcompletion` compose service). No
 * per-environment branching - the only difference is how the URL/secret resolve.
 */
export async function dispatchQuest(params: QuestStartBody, logger: Logger): Promise<void> {
  const url = `${Resource.ChatCompletion.url}/process`;
  const body = JSON.stringify(params);
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Shared-secret bearer - defense-in-depth on top of the VPC-internal boundary.
          authorization: `Bearer ${Resource.SECRET_ENCRYPTION_KEY.value}`,
        },
        body,
        signal: controller.signal,
      });

      if (res.status === 202) {
        logger.debug('Quest dispatched to ChatCompletion', { questId: params.questId, attempt });
        return;
      }

      const detail = await res.text().catch(() => '');
      lastError = new Error(`ChatCompletion dispatch failed: ${res.status} ${detail}`);
      // 4xx (auth/validation) is deterministic - fail fast instead of retrying. Throwing
      // here lets the catch below distinguish it by reference identity from network errors.
      if (res.status < 500) throw lastError;
    } catch (err) {
      // The non-retryable 4xx we just threw resurfaces here as the same object - rethrow it.
      if (err === lastError) throw err;
      // Connection error / abort (timeout) - retryable within the remaining budget.
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_ATTEMPTS && deadline - Date.now() > RETRY_BACKOFF_MS) {
      logger.warn('Retrying ChatCompletion dispatch', {
        questId: params.questId,
        error: lastError?.message,
      });
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }

  throw lastError ?? new Error('ChatCompletion dispatch failed: exhausted retries');
}

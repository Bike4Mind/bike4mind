import { Logger } from '@bike4mind/observability';

// Module-level concurrency semaphore for Anthropic API calls.
// Anthropic enforces an account-level concurrent connection limit. With multiple
// Lambda containers running in parallel, the effective per-container budget is
// roughly (account_limit / peak_container_count). Slots are acquired before the
// API call and released when the stream is fully consumed (or the response is
// received for non-streaming calls), so the semaphore accurately tracks real
// concurrent connection usage on Anthropic's side.
export const MAX_CONCURRENT_ANTHROPIC_CALLS = 15;
let _activeAnthropicCalls = 0;
const _anthropicWaitQueue: Array<() => void> = [];
// Module-level logger for semaphore events (no instance context available here).
const _semaphoreLogger = new Logger();

export function acquireSlot(): Promise<void> {
  if (_activeAnthropicCalls < MAX_CONCURRENT_ANTHROPIC_CALLS) {
    _activeAnthropicCalls++;
    return Promise.resolve();
  }
  // Log queue depth so operators can tune MAX_CONCURRENT_ANTHROPIC_CALLS.
  _semaphoreLogger.warn('[AnthropicBackend] Semaphore at capacity, queuing request', {
    active: _activeAnthropicCalls,
    queued: _anthropicWaitQueue.length + 1,
  });
  return new Promise<void>(resolve => {
    _anthropicWaitQueue.push(resolve);
  });
}

export function releaseSlot(): void {
  const next = _anthropicWaitQueue.shift();
  if (next) {
    // Slot transfers directly to the next waiter - active count stays the same.
    next();
  } else {
    _activeAnthropicCalls--;
  }
}

/** @internal Exposed for testing only. */
export const _semaphoreTestHelpers = {
  getActiveCount: () => _activeAnthropicCalls,
  getQueueLength: () => _anthropicWaitQueue.length,
  acquireSlot,
  releaseSlot,
  resetForTest: () => {
    _activeAnthropicCalls = 0;
    _anthropicWaitQueue.length = 0;
  },
  MAX_CONCURRENT: MAX_CONCURRENT_ANTHROPIC_CALLS,
};

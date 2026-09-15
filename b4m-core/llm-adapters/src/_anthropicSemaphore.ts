import { Logger } from '@bike4mind/observability';

// Module-level concurrency semaphore for Anthropic API calls.
//
// Anthropic enforces an account-level concurrent connection limit. With multiple
// Lambda containers running in parallel, the effective per-container budget is
// roughly (account_limit / peak_container_count). Slots are acquired before the
// API call and released when the stream is fully consumed (or the response is
// received for non-streaming calls), so the semaphore accurately tracks real
// concurrent connection usage on Anthropic's side.
//
// Fairness: the wait line is scheduled MIN-ACTIVE-FIRST across tenants, not
// strict FIFO. Plain FIFO is fair across REQUESTS but not across TENANTS - one
// tenant that queues a burst pushes every other tenant to the back of the line.
// When a slot frees it goes to a waiter of the tenant currently holding the
// fewest active slots (arrival order breaks ties), so a tenant with zero active
// slots is served on the next release regardless of how many requests a busy
// tenant has queued ahead of it. Within a single tenant this degrades to FIFO.
export const MAX_CONCURRENT_ANTHROPIC_CALLS = 15;

// Per-tenant cap on QUEUED (waiting, not active) requests. Active slots are already
// globally capped above; this bounds the wait line so one tenant cannot grow the
// shared queue without limit. Generous enough to admit a single user's legitimate
// parallel fan-out (multiple tabs, parallel subagents and tool calls all resolve to
// one hashed end-user id); a pathological flood is rejected fast rather than queued.
export const MAX_QUEUED_PER_TENANT = 100;

// Maximum time any waiter sits in the queue, applied to every acquire that does not pass
// an explicit `timeoutMs` - signal or not. A supplied signal is NOT a substitute: the
// interactive signal carries user-cancel always, but the request/idle timeout is only
// folded into it when the EnableStreamIdleTimeout admin setting is on, so on the default
// configuration a signal-bounded waiter would still wait indefinitely. Comfortably longer
// than the longest legitimate stream hold.
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000;

// Waiters with no tenant key share one bucket, so anonymous/non-interactive callers
// compete fairly with each other rather than each looking like a fresh zero-active tenant.
const ANON_TENANT = '';

// Module-level logger for semaphore events (no instance context available here).
const _semaphoreLogger = new Logger();

/** Returned by a successful acquire; call once to release the slot. Idempotent. */
export type SlotRelease = () => void;

export interface AcquireSlotOptions {
  /** Stable per-tenant id (e.g. hashed end-user id). Undefined shares one anonymous bucket. */
  tenantKey?: string;
  /** The waiter leaves the queue and the acquire rejects if this fires while it waits. */
  signal?: AbortSignal;
  /** Max time to wait for a slot before rejecting. Defaults to DEFAULT_ACQUIRE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Thrown when a slot cannot be obtained: the tenant's queue is full, or the wait timed out.
 * Both are transient backpressure on a shared pool rather than a fault in the request, so it
 * carries a 429 that the shared `shouldTriggerFallback` classifier reads (via `getHttpStatus`)
 * and hops the completion onto another model instead of surfacing a hard failure.
 */
export class SemaphoreBusyError extends Error {
  /** Read by the shared HTTP-status error classifiers; see the class doc. */
  readonly status = 429;

  constructor(message: string) {
    super(message);
    this.name = 'SemaphoreBusyError';
  }
}

type Waiter = {
  key: string;
  resolve: (release: SlotRelease) => void;
  /** Clears the timer and abort listener. Idempotent. */
  settle: () => void;
};

let _totalActive = 0;
const _activeByTenant = new Map<string, number>();
const _waiters: Waiter[] = [];

function incActive(key: string): void {
  _activeByTenant.set(key, (_activeByTenant.get(key) ?? 0) + 1);
  _totalActive++;
}

function decActive(key: string): void {
  const remaining = (_activeByTenant.get(key) ?? 0) - 1;
  if (remaining <= 0) _activeByTenant.delete(key);
  else _activeByTenant.set(key, remaining);
  _totalActive--;
}

function makeRelease(key: string): SlotRelease {
  let released = false;
  return () => {
    // Idempotent so a `finally { release() }` is safe even on paths that never acquired.
    if (released) return;
    released = true;
    decActive(key);
    admitNext();
  };
}

/**
 * Index of the waiter whose tenant holds the fewest active slots; arrival order breaks ties.
 * `_waiters` is only ever appended to and spliced from, so it is already in arrival order and
 * the strict `<` keeps the first-encountered (earliest) waiter on a tie - which is what makes
 * this degrade to FIFO within a single tenant.
 */
function pickFairWaiterIndex(): number {
  let best = -1;
  let bestActive = Infinity;
  for (let i = 0; i < _waiters.length; i++) {
    const active = _activeByTenant.get(_waiters[i].key) ?? 0;
    if (active < bestActive) {
      best = i;
      bestActive = active;
    }
  }
  return best;
}

function admitNext(): void {
  if (_totalActive >= MAX_CONCURRENT_ANTHROPIC_CALLS) return;
  const idx = pickFairWaiterIndex();
  if (idx === -1) return;
  const [waiter] = _waiters.splice(idx, 1);
  waiter.settle();
  incActive(waiter.key);
  waiter.resolve(makeRelease(waiter.key));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  // Match the AbortError shape the backend's catch already recognizes as a benign abort.
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Acquire a slot for an Anthropic API call, resolving with a release handle once one is
 * available. Rejects with an AbortError if `signal` fires while waiting, or a
 * SemaphoreBusyError if the tenant's queue is full or the wait times out.
 */
export function acquireSlot(opts: AcquireSlotOptions = {}): Promise<SlotRelease> {
  const key = opts.tenantKey ?? ANON_TENANT;
  const { signal } = opts;

  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }

  // Fast path: a slot is free and nobody is waiting, so a new caller cannot jump the line.
  if (_totalActive < MAX_CONCURRENT_ANTHROPIC_CALLS && _waiters.length === 0) {
    incActive(key);
    return Promise.resolve(makeRelease(key));
  }

  const queuedForTenant = _waiters.reduce((count, w) => (w.key === key ? count + 1 : count), 0);
  if (queuedForTenant >= MAX_QUEUED_PER_TENANT) {
    _semaphoreLogger.warn('[AnthropicSemaphore] Per-tenant queue cap reached, rejecting request', {
      active: _totalActive,
      queued: _waiters.length,
      tenantQueued: queuedForTenant,
    });
    return Promise.reject(
      new SemaphoreBusyError(
        `Anthropic request queue is full for this tenant (${queuedForTenant} already waiting); try again shortly`
      )
    );
  }

  _semaphoreLogger.warn('[AnthropicSemaphore] At capacity, queuing request', {
    active: _totalActive,
    queued: _waiters.length + 1,
  });

  return new Promise<SlotRelease>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

    const settle = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const removeAndReject = (err: Error) => {
      const idx = _waiters.indexOf(waiter);
      if (idx !== -1) _waiters.splice(idx, 1);
      settle();
      reject(err);
    };
    function onAbort() {
      removeAndReject(abortError(signal!));
    }

    // Armed before the waiter joins the queue, so no admit or abort can reach `settle`
    // (or the queue can reach `waiter`) while either is still uninitialized.
    const timer = setTimeout(
      () => removeAndReject(new SemaphoreBusyError(`Timed out after ${timeoutMs}ms waiting for an Anthropic slot`)),
      timeoutMs
    );

    const waiter: Waiter = { key, resolve, settle };
    _waiters.push(waiter);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** @internal Exposed for testing only. */
export const _semaphoreTestHelpers = {
  getActiveCount: () => _totalActive,
  getQueueLength: () => _waiters.length,
  getTenantActiveCount: (key = ANON_TENANT) => _activeByTenant.get(key) ?? 0,
  acquireSlot,
  resetForTest: () => {
    for (const waiter of _waiters) waiter.settle();
    _waiters.length = 0;
    _activeByTenant.clear();
    _totalActive = 0;
  },
  MAX_CONCURRENT: MAX_CONCURRENT_ANTHROPIC_CALLS,
  MAX_QUEUED_PER_TENANT,
};

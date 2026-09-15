import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _semaphoreTestHelpers,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  SemaphoreBusyError,
  type SlotRelease,
} from './_anthropicSemaphore';

const { getActiveCount, getQueueLength, acquireSlot, resetForTest, MAX_CONCURRENT, MAX_QUEUED_PER_TENANT } =
  _semaphoreTestHelpers;

/** Fill every slot with one tenant and return the release handles. */
async function saturate(tenantKey: string): Promise<SlotRelease[]> {
  const releases: SlotRelease[] = [];
  for (let i = 0; i < MAX_CONCURRENT; i++) releases.push(await acquireSlot({ tenantKey }));
  return releases;
}

/** Flush the microtask queue plus one macrotask so queued .then callbacks run. */
const flush = async () => {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('Anthropic semaphore', () => {
  beforeEach(() => {
    resetForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to MAX_CONCURRENT slots without queuing', async () => {
    expect(MAX_CONCURRENT).toBe(15);
    await saturate('A');
    expect(getActiveCount()).toBe(MAX_CONCURRENT);
    expect(getQueueLength()).toBe(0);
  });

  it('queues requests beyond MAX_CONCURRENT and admits one per release', async () => {
    const releases = await saturate('A');

    let admitted = false;
    const pending = acquireSlot({ tenantKey: 'A' }).then(() => {
      admitted = true;
    });
    await Promise.resolve();

    expect(admitted).toBe(false);
    expect(getQueueLength()).toBe(1);

    releases[0]();
    await pending;

    expect(admitted).toBe(true);
    expect(getActiveCount()).toBe(MAX_CONCURRENT); // slot transferred, not net-freed
    expect(getQueueLength()).toBe(0);
  });

  it('decrements active count when releasing with no waiters', async () => {
    const release = await acquireSlot({ tenantKey: 'A' });
    expect(getActiveCount()).toBe(1);
    release();
    expect(getActiveCount()).toBe(0);
  });

  it('processes same-tenant waiters in FIFO order', async () => {
    const releases = await saturate('A');
    const order: number[] = [];

    const w1 = acquireSlot({ tenantKey: 'A' }).then(() => order.push(1));
    const w2 = acquireSlot({ tenantKey: 'A' }).then(() => order.push(2));
    const w3 = acquireSlot({ tenantKey: 'A' }).then(() => order.push(3));
    expect(getQueueLength()).toBe(3);

    releases[0]();
    await w1;
    releases[1]();
    await w2;
    releases[2]();
    await w3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('release handle is idempotent (double release does not underflow)', async () => {
    const release = await acquireSlot({ tenantKey: 'A' });
    expect(getActiveCount()).toBe(1);
    release();
    release();
    expect(getActiveCount()).toBe(0);
  });

  // --- Fairness: the finding-99 regression ---
  it('serves a starved tenant on the first freed slot, not behind a busy tenant burst', async () => {
    const aReleases = await saturate('A'); // tenant A holds all 15 slots

    const admitOrder: string[] = [];
    const A_BURST = 40;
    // Tenant A queues a large burst; tenant B queues a single request AFTER all of them.
    for (let i = 0; i < A_BURST; i++) acquireSlot({ tenantKey: 'A' }).then(() => admitOrder.push(`A${i}`));
    acquireSlot({ tenantKey: 'B' }).then(() => admitOrder.push('B'));
    await Promise.resolve();
    expect(getQueueLength()).toBe(A_BURST + 1);

    // Free exactly one slot. Under plain FIFO, B (arrival #41) would wait behind all 40
    // of A's requests; min-active-first hands the freed slot to B (0 active) immediately.
    aReleases[0]();
    await flush();

    expect(admitOrder[0]).toBe('B');
  });

  // --- Abort-aware waiters ---
  it('drops a queued waiter that aborts, freeing nothing and consuming no slot', async () => {
    const releases = await saturate('A');

    const controller = new AbortController();
    const waiting = acquireSlot({ tenantKey: 'B', signal: controller.signal });
    await Promise.resolve();
    expect(getQueueLength()).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(getQueueLength()).toBe(0);

    // Releasing a real slot now must not resurrect the aborted waiter.
    releases[0]();
    await flush();
    expect(getActiveCount()).toBe(MAX_CONCURRENT - 1);
  });

  it('rejects immediately when the signal is already aborted, taking no slot', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireSlot({ tenantKey: 'A', signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(getActiveCount()).toBe(0);
  });

  // --- Per-tenant queue cap ---
  it('rejects a tenant that queues past MAX_QUEUED_PER_TENANT while other tenants still queue', async () => {
    await saturate('A');

    for (let i = 0; i < MAX_QUEUED_PER_TENANT; i++) {
      void acquireSlot({ tenantKey: 'A' }).catch(() => {}); // stay pending
    }
    await Promise.resolve();
    expect(getQueueLength()).toBe(MAX_QUEUED_PER_TENANT);

    // One more from the same tenant is rejected fast rather than queued.
    await expect(acquireSlot({ tenantKey: 'A' })).rejects.toBeInstanceOf(SemaphoreBusyError);

    // A different tenant is unaffected by A's full queue.
    void acquireSlot({ tenantKey: 'B' }).catch(() => {});
    await Promise.resolve();
    expect(getQueueLength()).toBe(MAX_QUEUED_PER_TENANT + 1);
  });

  // --- Fallback wait timeout ---
  it('times out a signal-less waiter after timeoutMs and removes it from the queue', async () => {
    await saturate('A');

    const start = Date.now();
    await expect(acquireSlot({ tenantKey: 'A', timeoutMs: 20 })).rejects.toBeInstanceOf(SemaphoreBusyError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(getQueueLength()).toBe(0);
  });

  it('bounds a waiter that supplies a signal, not only signal-less callers', async () => {
    // A signal is not a wait bound on its own: the interactive signal carries user-cancel
    // always, but the request/idle timeout only joins it when an admin setting is on.
    vi.useFakeTimers();
    await saturate('A');

    const controller = new AbortController();
    const waiting = acquireSlot({ tenantKey: 'A', signal: controller.signal });
    const rejection = expect(waiting).rejects.toBeInstanceOf(SemaphoreBusyError);
    expect(getQueueLength()).toBe(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_ACQUIRE_TIMEOUT_MS);

    await rejection;
    expect(getQueueLength()).toBe(0);
  });

  it('carries a 429 so the shared fallback classifier reads it as transient backpressure', () => {
    expect(new SemaphoreBusyError('queue full').status).toBe(429);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { _semaphoreTestHelpers } from './_anthropicSemaphore';

const { getActiveCount, getQueueLength, acquireSlot, releaseSlot, resetForTest, MAX_CONCURRENT } =
  _semaphoreTestHelpers;

describe('Anthropic semaphore', () => {
  beforeEach(() => {
    resetForTest();
  });

  it('should allow up to MAX_CONCURRENT slots', async () => {
    expect(MAX_CONCURRENT).toBe(15);

    for (let i = 0; i < MAX_CONCURRENT; i++) {
      await acquireSlot();
    }

    expect(getActiveCount()).toBe(MAX_CONCURRENT);
    expect(getQueueLength()).toBe(0);
  });

  it('should queue requests beyond MAX_CONCURRENT', async () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      await acquireSlot();
    }

    // This one should queue (not resolve yet)
    let queued = false;
    const pending = acquireSlot().then(() => {
      queued = true;
    });

    // Allow microtasks to flush
    await Promise.resolve();

    expect(queued).toBe(false);
    expect(getQueueLength()).toBe(1);

    // Release one slot - the queued request should resolve
    releaseSlot();
    await pending;

    expect(queued).toBe(true);
    expect(getActiveCount()).toBe(MAX_CONCURRENT);
    expect(getQueueLength()).toBe(0);
  });

  it('should decrement active count when no waiters', async () => {
    await acquireSlot();
    expect(getActiveCount()).toBe(1);

    releaseSlot();
    expect(getActiveCount()).toBe(0);
  });

  it('should transfer slot to next waiter without decrementing', async () => {
    // Fill all slots
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      await acquireSlot();
    }

    // Queue a waiter
    let waiterResolved = false;
    const waiterPromise = acquireSlot().then(() => {
      waiterResolved = true;
    });

    // Release one slot - should transfer directly
    releaseSlot();
    await waiterPromise;

    expect(waiterResolved).toBe(true);
    // Active count stays the same (slot transferred, not decremented then incremented)
    expect(getActiveCount()).toBe(MAX_CONCURRENT);
  });

  it('should underflow on unbalanced release (no guard in raw semaphore)', () => {
    // Calling releaseSlot() without a matching acquireSlot() decrements below zero.
    // This documents the raw behavior - callers are responsible for balanced acquire/release.
    releaseSlot();
    expect(getActiveCount()).toBe(-1);

    resetForTest();
    expect(getActiveCount()).toBe(0);
  });

  it('should process queued waiters in FIFO order', async () => {
    // Fill all slots
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      await acquireSlot();
    }

    const resolveOrder: number[] = [];

    const waiter1 = acquireSlot().then(() => resolveOrder.push(1));
    const waiter2 = acquireSlot().then(() => resolveOrder.push(2));
    const waiter3 = acquireSlot().then(() => resolveOrder.push(3));

    expect(getQueueLength()).toBe(3);

    // Release three slots - should resolve in order
    releaseSlot();
    await waiter1;
    releaseSlot();
    await waiter2;
    releaseSlot();
    await waiter3;

    expect(resolveOrder).toEqual([1, 2, 3]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '@shared/loop';
import { LoopScheduler, type LoopOutcome } from './LoopScheduler';

const state = (intervalMs: number | null = 30_000): LoopState => ({
  sessionId: 's',
  prompt: 'check',
  intervalMs,
  phase: 'scheduled',
  nextRunAt: null,
});

describe('LoopScheduler', () => {
  let busy: boolean;
  let scheduler: LoopScheduler;
  beforeEach(() => {
    vi.useFakeTimers();
    busy = false;
    scheduler = new LoopScheduler(() => busy, vi.fn());
  });
  afterEach(() => {
    scheduler.clear();
    vi.useRealTimers();
  });

  it('never overlaps runs or catches up missed intervals', async () => {
    let finish!: (value: LoopOutcome) => void;
    const run = vi.fn(
      () =>
        new Promise<LoopOutcome>(resolve => {
          finish = resolve;
        })
    );
    scheduler.start(state(), run);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * 86_400_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish({ ok: true, reply: 'done' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits without polling and starts only when the user turn and queue are idle', async () => {
    busy = true;
    const run = vi.fn(async () => ({ ok: true as const, reply: 'done' }));
    scheduler.start(state(), run);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.get('s')?.phase).toBe('waiting');
    expect(vi.getTimerCount()).toBe(0);
    scheduler.idle('s');
    expect(run).not.toHaveBeenCalled();
    busy = false;
    scheduler.idle('s');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses the model-selected delay and pauses rather than inventing one', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, reply: 'wait\nLOOP_NEXT: 2m' })
      .mockResolvedValue({ ok: true, reply: 'no decision' });
    scheduler.start(state(null), run);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.get('s')?.nextRunAt).toBe(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scheduler.get('s')?.phase).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('pauses on a refused run or thrown error (%s) without retries', async throws => {
    const run = vi.fn(async (): Promise<LoopOutcome> => {
      if (throws) throw new Error('offline');
      return { ok: false, error: 'credits' };
    });
    scheduler.start(state(), run);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.get('s')).toMatchObject({ phase: 'paused', nextRunAt: null });
  });

  it('cancels pending work and ignores completion after stop or replacement', async () => {
    let finish!: (value: LoopOutcome) => void;
    let signal!: AbortSignal;
    scheduler.start(state(), value => {
      signal = value;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop('s');
    expect(signal.aborted).toBe(true);
    finish({ ok: true, reply: 'done' });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(scheduler.get('s')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds a waiting loop after an ordinary turn fails', async () => {
    busy = true;
    const run = vi.fn();
    scheduler.start(state(), run);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.pauseWaiting('s');
    busy = false;
    scheduler.idle('s');
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.get('s')?.phase).toBe('paused');
  });

  it('has no persisted restart state and clears all timers on shutdown', async () => {
    scheduler.start(state(), vi.fn());
    scheduler.clear();
    scheduler = new LoopScheduler(() => false, vi.fn());
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(scheduler.get('s')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

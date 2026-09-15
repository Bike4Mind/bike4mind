import { describe, expect, it } from 'vitest';
import { limitConcurrency } from './concurrency';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('limitConcurrency', () => {
  it('never runs more tasks than the cap at once', async () => {
    const limit = limitConcurrency(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => limit(task)));
    expect(peak).toBe(2);
  });

  it('returns each task result and starts queued work in submission order', async () => {
    const limit = limitConcurrency(1);
    const started: number[] = [];
    const results = await Promise.all(
      [1, 2, 3].map(n =>
        limit(async () => {
          started.push(n);
          await tick();
          return n * 10;
        })
      )
    );
    expect(results).toEqual([10, 20, 30]);
    expect(started).toEqual([1, 2, 3]);
  });

  it('releases the slot when a task throws, so the queue keeps draining', async () => {
    const limit = limitConcurrency(1);
    const failing = limit(async () => {
      throw new Error('boom');
    });
    const following = limit(async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    expect(await following).toBe('ran');
  });

  it('re-checks the cap when a released waiter resumes', async () => {
    const limit = limitConcurrency(1);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    };

    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await held;
      active -= 1;
    });
    const queued = limit(task);
    await tick();

    // Freeing the slot only SCHEDULES the waiter; it resumes a microtask later.
    // Submitting across the next few microtask depths puts one task squarely in
    // that window, where the old gate let it take the slot the waiter was about
    // to claim without the waiter re-checking.
    release();
    const submitted: Array<Promise<void>> = [];
    for (let depth = 0; depth <= 4; depth += 1) {
      const hop = (remaining: number) => {
        if (remaining === 0) submitted.push(limit(task));
        else queueMicrotask(() => hop(remaining - 1));
      };
      hop(depth);
    }

    await Promise.all([first, queued]);
    await Promise.all(submitted);
    expect(peak).toBe(1);
  });

  it('treats a nonsensical cap as a cap of one', async () => {
    const limit = limitConcurrency(0);
    expect(await limit(async () => 'still runs')).toBe('still runs');
  });
});

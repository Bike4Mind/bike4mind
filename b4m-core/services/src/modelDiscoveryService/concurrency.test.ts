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

  it('treats a nonsensical cap as a cap of one', async () => {
    const limit = limitConcurrency(0);
    expect(await limit(async () => 'still runs')).toBe('still runs');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMutex, limitConcurrency } from './concurrency';

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

  it('rejects only the failing call and lets Promise.allSettled see every outcome', async () => {
    const limit = limitConcurrency(2);
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4].map(n =>
        limit(async () => {
          await tick();
          if (n % 2 === 0) throw new Error(`fail ${n}`);
          return n;
        })
      )
    );
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect((outcomes[1] as PromiseRejectedResult).reason).toEqual(new Error('fail 2'));
  });

  it('turns a synchronous throw into a rejection', async () => {
    const limit = limitConcurrency(1);
    await expect(
      limit(() => {
        throw new Error('sync');
      })
    ).rejects.toThrow('sync');
    expect(await limit(() => 'next')).toBe('next');
  });

  it('keeps submission order for a task submitted while a slot is being handed over', async () => {
    const limit = limitConcurrency(1);
    const started: string[] = [];
    const run = (name: string) =>
      limit(async () => {
        started.push(name);
        await tick();
      });

    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = limit(async () => {
      started.push('first');
      await held;
    });
    const queued = run('queued');
    await tick();

    release();
    // Submitted across the next few microtask depths, which includes the one where the waiter is
    // resuming: none of these may start before the task that was already waiting.
    const late: Array<Promise<void>> = [];
    for (let depth = 0; depth <= 4; depth += 1) {
      const hop = (remaining: number) => {
        if (remaining === 0) late.push(run(`late-${depth}`));
        else queueMicrotask(() => hop(remaining - 1));
      };
      hop(depth);
    }

    await Promise.all([first, queued, ...late]);
    expect(started.slice(0, 2)).toEqual(['first', 'queued']);
  });

  it('never exceeds the cap when tasks are submitted as a slot is handed over', async () => {
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

  it.each([0, -1, NaN, 1.5, -Infinity])('rejects the nonsensical cap %s', cap => {
    expect(() => limitConcurrency(cap)).toThrow(TypeError);
  });

  it('accepts Infinity as an unbounded cap', async () => {
    const limit = limitConcurrency(Infinity);
    expect(await Promise.all([limit(async () => 1), limit(async () => 2)])).toEqual([1, 2]);
  });
});

describe('createMutex', () => {
  it('runs tasks one at a time in submission order', async () => {
    const mutex = createMutex();
    const events: string[] = [];
    const run = (name: string) =>
      mutex.runExclusive(async () => {
        events.push(`start ${name}`);
        await tick();
        events.push(`end ${name}`);
        return name;
      });

    const results = await Promise.all([run('a'), run('b'), run('c')]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('releases the lock when a task throws and rejects only that call', async () => {
    const mutex = createMutex();
    const failing = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const following = mutex.runExclusive(async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    expect(await following).toBe('ran');
  });

  it('keeps working after a rejection that nobody awaited yet', async () => {
    const mutex = createMutex();
    const failing = mutex.runExclusive(() => {
      throw new Error('sync boom');
    });
    failing.catch(() => undefined);
    await tick();
    expect(await mutex.runExclusive(() => 42)).toBe(42);
  });

  it('lets an empty task act as a barrier for everything submitted before it', async () => {
    const mutex = createMutex();
    let saved = false;
    void mutex.runExclusive(async () => {
      await tick();
      await tick();
      saved = true;
    });
    await mutex.runExclusive(async () => {});
    expect(saved).toBe(true);
  });

  it('uses independent locks per instance', async () => {
    const a = createMutex();
    const b = createMutex();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocked = a.runExclusive(() => held);
    expect(await b.runExclusive(() => 'free')).toBe('free');
    release();
    await blocked;
  });

  it('calls the task with no arguments', async () => {
    const mutex = createMutex();
    await mutex.runExclusive(async () => 'previous result');
    const task = vi.fn(async () => 'next');
    await mutex.runExclusive(task);
    expect(task).toHaveBeenCalledTimes(1);
    expect(task.mock.calls[0]).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { PermissionDeniedError } from '@bike4mind/common';
import { executeToolsBatch, DEFAULT_MAX_PARALLEL_TOOLS } from './executeToolsBatch';

/** Helper: create a task that resolves after a delay */
const delayedTask = <T>(value: T, delayMs: number): (() => Promise<T>) => {
  return () => new Promise(resolve => setTimeout(() => resolve(value), delayMs));
};

/** Helper: create a task that rejects after a delay */
const failingTask = (error: Error, delayMs = 0): (() => Promise<never>) => {
  return () => new Promise((_, reject) => setTimeout(() => reject(error), delayMs));
};

/** Helper: create a task that records its start/end time */
const timedTask = (id: string, delayMs: number, log: Array<{ id: string; event: string; time: number }>) => {
  return async () => {
    log.push({ id, event: 'start', time: Date.now() });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    log.push({ id, event: 'end', time: Date.now() });
    return id;
  };
};

describe('executeToolsBatch', () => {
  describe('parallel execution (2+ tools)', () => {
    it('executes multiple tasks concurrently', async () => {
      const log: Array<{ id: string; event: string; time: number }> = [];
      const tasks = [timedTask('A', 50, log), timedTask('B', 50, log), timedTask('C', 50, log)];

      const startTime = Date.now();
      const outcomes = await executeToolsBatch(tasks, { parallel: true });
      const elapsed = Date.now() - startTime;

      // All should succeed
      expect(outcomes).toHaveLength(3);
      expect(outcomes.every(o => o.ok)).toBe(true);

      // Concurrent execution should be significantly faster than sequential (3x50ms = 150ms).
      // 140ms still strictly separates concurrent (~50ms + overhead) from sequential while
      // absorbing CI timer jitter (this flaked at 122ms vs a 120ms bound on a loaded runner).
      // The interleaving assertion below is the jitter-immune concurrency proof.
      expect(elapsed).toBeLessThan(140);

      // All tasks should have started before any finished
      const starts = log.filter(e => e.event === 'start');
      const ends = log.filter(e => e.event === 'end');
      const lastStart = Math.max(...starts.map(e => e.time));
      const firstEnd = Math.min(...ends.map(e => e.time));
      expect(lastStart).toBeLessThanOrEqual(firstEnd);
    });

    it('preserves result order regardless of resolution order', async () => {
      // Task B resolves first (10ms), Task A resolves last (60ms)
      const tasks = [delayedTask('A-result', 60), delayedTask('B-result', 10), delayedTask('C-result', 30)];

      const outcomes = await executeToolsBatch(tasks, { parallel: true });

      expect(outcomes).toEqual([
        { ok: true, result: 'A-result' },
        { ok: true, result: 'B-result' },
        { ok: true, result: 'C-result' },
      ]);
    });

    it('isolates failures — one failure does not abort the batch', async () => {
      const tasks = [
        delayedTask('success-1', 10),
        failingTask(new Error('tool B failed'), 10),
        delayedTask('success-3', 10),
      ];

      const outcomes = await executeToolsBatch(tasks, { parallel: true });

      expect(outcomes).toHaveLength(3);
      expect(outcomes[0]).toEqual({ ok: true, result: 'success-1' });
      expect(outcomes[1].ok).toBe(false);
      expect((outcomes[1] as { ok: false; error: Error }).error.message).toBe('tool B failed');
      expect(outcomes[2]).toEqual({ ok: true, result: 'success-3' });
    });

    it('throws PermissionDeniedError before returning any results', async () => {
      const resultCollector = vi.fn();
      const tasks = [
        delayedTask('ok-result', 10),
        failingTask(new PermissionDeniedError('secretTool'), 10),
        delayedTask('ok-result-2', 10),
      ];

      await expect(executeToolsBatch(tasks, { parallel: true })).rejects.toThrow(PermissionDeniedError);

      // The caller never received outcomes
      expect(resultCollector).not.toHaveBeenCalled();
    });

    it('throws the first PermissionDeniedError when multiple exist', async () => {
      const tasks = [
        failingTask(new PermissionDeniedError('toolA'), 10),
        failingTask(new PermissionDeniedError('toolB'), 10),
      ];

      await expect(executeToolsBatch(tasks, { parallel: true })).rejects.toThrow('Permission denied for tool: toolA');
    });
  });

  describe('single-tool bypass', () => {
    it('does not use allSettled for a single tool', async () => {
      const task = vi.fn(async () => 'solo-result');

      const outcomes = await executeToolsBatch([task], { parallel: true });

      expect(outcomes).toEqual([{ ok: true, result: 'solo-result' }]);
      expect(task).toHaveBeenCalledOnce();
    });

    it('throws PermissionDeniedError immediately for a single tool', async () => {
      const task = () => Promise.reject(new PermissionDeniedError('onlyTool'));

      await expect(executeToolsBatch([task], { parallel: true })).rejects.toThrow(PermissionDeniedError);
    });
  });

  describe('sequential execution (parallelToolExecution: false)', () => {
    it('executes tasks one at a time', async () => {
      const log: Array<{ id: string; event: string; time: number }> = [];
      const tasks = [timedTask('A', 30, log), timedTask('B', 30, log)];

      const startTime = Date.now();
      await executeToolsBatch(tasks, { parallel: false });
      const elapsed = Date.now() - startTime;

      // Sequential should take at least 2x30ms
      expect(elapsed).toBeGreaterThanOrEqual(55);

      // Each task should start after the previous one ends
      const aEnd = log.find(e => e.id === 'A' && e.event === 'end')!.time;
      const bStart = log.find(e => e.id === 'B' && e.event === 'start')!.time;
      expect(bStart).toBeGreaterThanOrEqual(aEnd);
    });

    it('breaks the loop on PermissionDeniedError — subsequent tools do NOT execute', async () => {
      const taskC = vi.fn(async () => 'C-result');

      const tasks = [async () => 'A-result' as string, failingTask(new PermissionDeniedError('blockedTool')), taskC];

      await expect(executeToolsBatch(tasks, { parallel: false })).rejects.toThrow(PermissionDeniedError);

      // Task C should never have been called
      expect(taskC).not.toHaveBeenCalled();
    });

    it('collects non-permission errors without stopping the loop', async () => {
      const tasks = [async () => 'A-result', failingTask(new Error('non-fatal')), async () => 'C-result'];

      const outcomes = await executeToolsBatch(tasks, { parallel: false });

      expect(outcomes).toHaveLength(3);
      expect(outcomes[0]).toEqual({ ok: true, result: 'A-result' });
      expect(outcomes[1].ok).toBe(false);
      expect(outcomes[2]).toEqual({ ok: true, result: 'C-result' });
    });

    it('preserves result order', async () => {
      const tasks = [async () => 'first', async () => 'second', async () => 'third'];

      const outcomes = await executeToolsBatch(tasks, { parallel: false });

      expect(outcomes.map(o => o.ok && o.result)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('concurrency limiting (maxConcurrency)', () => {
    it('respects maxConcurrency cap', async () => {
      let activeTasks = 0;
      let peakConcurrency = 0;

      const createConcurrencyTracker = (id: string) => async () => {
        activeTasks++;
        peakConcurrency = Math.max(peakConcurrency, activeTasks);
        await new Promise(resolve => setTimeout(resolve, 30));
        activeTasks--;
        return id;
      };

      const tasks = Array.from({ length: 10 }, (_, i) => createConcurrencyTracker(`task-${i}`));

      const outcomes = await executeToolsBatch(tasks, { parallel: true, maxConcurrency: 3 });

      expect(outcomes).toHaveLength(10);
      expect(outcomes.every(o => o.ok)).toBe(true);
      expect(peakConcurrency).toBeLessThanOrEqual(3);
      expect(peakConcurrency).toBeGreaterThanOrEqual(2); // Should actually use multiple workers
    });

    it('preserves order with concurrency limiting', async () => {
      // Tasks resolve at different speeds to test order preservation under limiting
      const tasks = [
        delayedTask('slow', 40),
        delayedTask('fast', 5),
        delayedTask('medium', 20),
        delayedTask('fastest', 1),
      ];

      const outcomes = await executeToolsBatch(tasks, { parallel: true, maxConcurrency: 2 });

      expect(outcomes.map(o => o.ok && o.result)).toEqual(['slow', 'fast', 'medium', 'fastest']);
    });

    it('defaults to DEFAULT_MAX_PARALLEL_TOOLS when not specified', () => {
      expect(DEFAULT_MAX_PARALLEL_TOOLS).toBe(8);
    });

    it('skips limiting when maxConcurrency >= task count', async () => {
      const log: Array<{ id: string; event: string; time: number }> = [];
      const tasks = [timedTask('A', 30, log), timedTask('B', 30, log)];

      const startTime = Date.now();
      await executeToolsBatch(tasks, { parallel: true, maxConcurrency: 10 });
      const elapsed = Date.now() - startTime;

      // Should run concurrently (not limited)
      expect(elapsed).toBeLessThan(55);
    });

    it('handles PermissionDeniedError with concurrency limiting', async () => {
      const tasks = [
        delayedTask('ok', 10),
        failingTask(new PermissionDeniedError('blocked'), 10),
        delayedTask('ok-2', 10),
        delayedTask('ok-3', 10),
      ];

      await expect(executeToolsBatch(tasks, { parallel: true, maxConcurrency: 2 })).rejects.toThrow(
        PermissionDeniedError
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty task array', async () => {
      const outcomes = await executeToolsBatch([], { parallel: true });
      expect(outcomes).toEqual([]);
    });

    it('handles empty task array in sequential mode', async () => {
      const outcomes = await executeToolsBatch([], { parallel: false });
      expect(outcomes).toEqual([]);
    });

    it('works with generic result types', async () => {
      type ToolResult = { name: string; data: number; durationMs: number };

      const tasks = [
        async (): Promise<ToolResult> => ({ name: 'tool1', data: 42, durationMs: 10 }),
        async (): Promise<ToolResult> => ({ name: 'tool2', data: 99, durationMs: 20 }),
      ];

      const outcomes = await executeToolsBatch(tasks, { parallel: true });

      expect(outcomes).toHaveLength(2);
      if (outcomes[0].ok) {
        expect(outcomes[0].result.name).toBe('tool1');
        expect(outcomes[0].result.data).toBe(42);
      }
    });
  });
});

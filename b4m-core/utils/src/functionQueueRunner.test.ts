import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import FunctionQueueRunner from './functionQueueRunner';

describe('FunctionQueueRunner', () => {
  let runner: FunctionQueueRunner;
  const TEST_INTERVAL = 100; // 100ms for faster tests

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useFakeTimers();
    runner = new FunctionQueueRunner(TEST_INTERVAL);
  });

  afterEach(async () => {
    // Clean up any running intervals
    try {
      const closePromise = runner.close();
      // Advance timers just enough to handle the setTimeout in close()
      await vi.advanceTimersByTimeAsync(TEST_INTERVAL);
      await closePromise;
    } catch (error) {
      // Runner might already be closed
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize and start running automatically', () => {
      // Can't access private properties, but we can verify it's working by adding a function
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());
      runner.add(mockFn);

      // Advance timer to verify the runner is working
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should use default interval when no interval provided and start running', async () => {
      const defaultRunner = new FunctionQueueRunner();
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());
      defaultRunner.add(mockFn);

      // Advance timer with default interval (1000ms)
      vi.advanceTimersByTime(1000);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Clean up without runAllTimersAsync to avoid infinite loop
      const closePromise = defaultRunner.close();
      // Advance timers just enough to handle the setTimeout in close()
      vi.advanceTimersByTime(500); // interval / 2 = 1000 / 2 = 500
      await closePromise;
    });
  });

  describe('add', () => {
    it('should add a function to the queue', () => {
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());

      runner.add(mockFn);

      // Verify function was added by checking it gets executed
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should add multiple functions to the queue in order', () => {
      const mockFn1 = vi.fn().mockReturnValue(Promise.resolve());
      const mockFn2 = vi.fn().mockReturnValue(Promise.resolve());
      const mockFn3 = vi.fn().mockReturnValue(Promise.resolve());

      runner.add(mockFn1);
      runner.add(mockFn2);
      runner.add(mockFn3);

      // Verify all functions were added by checking execution order
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).not.toHaveBeenCalled();
      expect(mockFn3).not.toHaveBeenCalled();

      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn2).toHaveBeenCalledTimes(1);
      expect(mockFn3).not.toHaveBeenCalled();

      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn3).toHaveBeenCalledTimes(1);
    });
  });

  describe('run', () => {
    it('should already be running from constructor', () => {
      // Verify it's running by adding a function and checking execution
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());
      runner.add(mockFn);

      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should execute functions from the queue at specified intervals', async () => {
      const promise1 = Promise.resolve();
      const promise2 = Promise.resolve();
      const mockFn1 = vi.fn().mockReturnValue(promise1);
      const mockFn2 = vi.fn().mockReturnValue(promise2);

      runner.add(mockFn1);
      runner.add(mockFn2);
      // No need to call run() - it's already running from constructor

      // Initially, no functions should be called
      expect(mockFn1).not.toHaveBeenCalled();
      expect(mockFn2).not.toHaveBeenCalled();

      // After first interval, first function should be called
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).not.toHaveBeenCalled();

      // After second interval, second function should be called
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).toHaveBeenCalledTimes(1);

      // Wait for all promises to resolve
      await Promise.all([promise1, promise2]);
    });

    it('should execute functions in FIFO order', async () => {
      const executionOrder: number[] = [];
      let resolve1: () => void;
      let resolve2: () => void;
      let resolve3: () => void;

      const promise1 = new Promise<void>(resolve => {
        resolve1 = resolve;
      });
      const promise2 = new Promise<void>(resolve => {
        resolve2 = resolve;
      });
      const promise3 = new Promise<void>(resolve => {
        resolve3 = resolve;
      });

      const mockFn1 = vi.fn().mockImplementation(() => {
        executionOrder.push(1);
        resolve1();
        return promise1;
      });
      const mockFn2 = vi.fn().mockImplementation(() => {
        executionOrder.push(2);
        resolve2();
        return promise2;
      });
      const mockFn3 = vi.fn().mockImplementation(() => {
        executionOrder.push(3);
        resolve3();
        return promise3;
      });

      runner.add(mockFn1);
      runner.add(mockFn2);
      runner.add(mockFn3);
      // No need to call run() - it's already running from constructor

      // Execute all intervals
      vi.advanceTimersByTime(TEST_INTERVAL * 3);

      // Wait for all functions to complete
      await Promise.all([promise1, promise2, promise3]);

      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should continue running interval even when queue becomes empty', async () => {
      let resolveFn: () => void;
      const promise = new Promise<void>(resolve => {
        resolveFn = resolve;
      });
      const mockFn = vi.fn().mockReturnValue(promise);

      runner.add(mockFn);
      // No need to call run() - it's already running from constructor

      // Execute the function
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn).toHaveBeenCalled();

      // Resolve the promise
      resolveFn!();
      await promise;

      // Verify interval is still running by adding another function
      const mockFn2 = vi.fn().mockReturnValue(Promise.resolve());
      runner.add(mockFn2);
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn2).toHaveBeenCalled();
    });

    it('should handle empty queue gracefully', () => {
      // No need to call run() - it's already running from constructor

      // Advance timer when queue is empty - should not crash
      vi.advanceTimersByTime(TEST_INTERVAL);

      // Verify it's still working by adding a function
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());
      runner.add(mockFn);
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn).toHaveBeenCalled();
    });

    it('should not execute functions if queue is empty during interval', () => {
      const mockFn = vi.fn().mockReturnValue(Promise.resolve());

      // Queue is already empty and runner is already started from constructor

      vi.advanceTimersByTime(TEST_INTERVAL);

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should handle async function errors gracefully', async () => {
      const logSpy = vi.spyOn(Logger.globalInstance, 'log').mockImplementation(() => {});
      const errorPromise = Promise.reject(new Error('Test error'));
      const successPromise = Promise.resolve();

      const errorFn = vi.fn().mockReturnValue(errorPromise);
      const successFn = vi.fn().mockReturnValue(successPromise);

      runner.add(errorFn);
      runner.add(successFn);
      // No need to call run() - it's already running from constructor

      // Should not throw and continue processing
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(errorFn).toHaveBeenCalled();

      // Wait for error to be caught and logged
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith('Error running function', expect.any(Error));
      });

      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(successFn).toHaveBeenCalled();
      await successPromise;

      // Close the runner to stop the interval from continuing indefinitely
      const closePromise = runner.close();
      vi.advanceTimersByTime(TEST_INTERVAL);
      await closePromise;

      logSpy.mockRestore();
    });
  });

  describe('adding functions to running queue', () => {
    it('should allow adding functions to the already running queue', async () => {
      const promise1 = Promise.resolve();
      const promise2 = Promise.resolve();
      const mockFn1 = vi.fn().mockReturnValue(promise1);
      const mockFn2 = vi.fn().mockReturnValue(promise2);

      // Add first function (runner is already running from constructor)
      runner.add(mockFn1);
      vi.advanceTimersByTime(TEST_INTERVAL);

      expect(mockFn1).toHaveBeenCalledTimes(1);
      await promise1;

      // Add second function to the running queue
      runner.add(mockFn2);
      vi.advanceTimersByTime(TEST_INTERVAL);

      expect(mockFn2).toHaveBeenCalledTimes(1);
      await promise2;
    });
  });

  describe('close', () => {
    it('should stop the interval and process remaining queue when close is called', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const mockFn1 = vi.fn().mockResolvedValue(undefined);
      const mockFn2 = vi.fn().mockResolvedValue(undefined);

      // Add functions to queue
      runner.add(mockFn1);
      runner.add(mockFn2);

      // Start the close operation
      const closePromise = runner.close();

      // Advance timers to process all functions and their delays
      await vi.advanceTimersByTimeAsync(TEST_INTERVAL);

      // Wait for close to complete
      await closePromise;

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(mockFn1).toHaveBeenCalled();
      expect(mockFn2).toHaveBeenCalled();
    });

    it('should not execute more functions through interval after close is called', async () => {
      const mockFn1 = vi.fn().mockResolvedValue(undefined);
      const mockFn2 = vi.fn().mockResolvedValue(undefined);

      runner.add(mockFn1);

      // Execute first function via interval
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn1).toHaveBeenCalled();

      // Add second function and close immediately
      runner.add(mockFn2);
      const closePromise = runner.close();

      // Advance timers to handle the setTimeout calls in close()
      await vi.advanceTimersByTimeAsync(TEST_INTERVAL);

      // Wait for close to complete
      await closePromise;

      // Second function should have been processed by close(), not by interval
      expect(mockFn2).toHaveBeenCalled();

      // Advance timer - no more functions should be called after close
      const mockFn3 = vi.fn().mockResolvedValue(undefined);
      runner.add(mockFn3);
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn3).not.toHaveBeenCalled();
    });

    it('should handle close being called multiple times', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // Call close multiple times
      const closePromise1 = runner.close();
      vi.advanceTimersByTime(TEST_INTERVAL);
      await closePromise1;

      const closePromise2 = runner.close();
      vi.advanceTimersByTime(TEST_INTERVAL);
      await closePromise2;

      const closePromise3 = runner.close();
      vi.advanceTimersByTime(TEST_INTERVAL);
      await closePromise3;

      // clearInterval will be called for each close() call, but it's safe to call multiple times
      expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
    });

    it('should handle close being called on empty queue', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      // Close with empty queue should work normally
      const closePromise = runner.close();
      vi.advanceTimersByTime(TEST_INTERVAL);
      await closePromise;

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('queue manipulation during execution', () => {
    it('should handle adding functions while queue is running', async () => {
      let resolve1!: () => void;
      let resolve2!: () => void;
      const promise1 = new Promise<void>(resolve => {
        resolve1 = resolve;
      });
      const promise2 = new Promise<void>(resolve => {
        resolve2 = resolve;
      });
      const mockFn1 = vi.fn().mockReturnValue(promise1);
      const mockFn2 = vi.fn().mockReturnValue(promise2);

      runner.add(mockFn1);
      // Runner is already running from constructor

      // Execute first function
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn1).toHaveBeenCalled();

      // Add another function before completing the first one (queue not empty yet)
      runner.add(mockFn2);

      // Complete first function
      resolve1!();
      await promise1;

      // Execute second function - the interval should still be running since queue wasn't empty
      vi.advanceTimersByTime(TEST_INTERVAL);
      expect(mockFn2).toHaveBeenCalled();

      // Complete second function
      resolve2!();
      await promise2;
    });
  });
});

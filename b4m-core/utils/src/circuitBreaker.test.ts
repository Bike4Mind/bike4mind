import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitBreakerError } from './circuitBreaker';
import type { CircuitBreakerConfig, StateChangeEvent } from './circuitBreaker';

describe('circuitBreaker', () => {
  const defaultConfig: CircuitBreakerConfig = {
    name: 'test',
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeout: 100,
    rollingWindowMs: 5000,
  };

  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(defaultConfig);
  });

  describe('CLOSED state (normal operation)', () => {
    it('should execute successfully in CLOSED state', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await breaker.execute(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledOnce();
    });

    it('should propagate errors without tripping if below threshold', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().failureCount).toBe(1);
    });

    it('should trip to OPEN after reaching failure threshold', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      expect(breaker.getState().state).toBe('OPEN');
    });

    it('should not count non-failure errors when isFailure returns false', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        isFailure: err => !err.message.includes('404'),
      });

      const fn404 = vi.fn().mockRejectedValue(new Error('404 not found'));

      for (let i = 0; i < 5; i++) {
        await expect(cb.execute(fn404)).rejects.toThrow('404');
      }

      // Should still be CLOSED because 404 errors don't count as failures
      expect(cb.getState().state).toBe('CLOSED');
      expect(cb.getState().failureCount).toBe(0);
    });
  });

  describe('rolling window failure tracking', () => {
    it('should prune failures outside the rolling window', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 3,
        rollingWindowMs: 50,
      });

      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Record 2 failures
      await expect(cb.execute(fn)).rejects.toThrow('fail');
      await expect(cb.execute(fn)).rejects.toThrow('fail');
      expect(cb.getState().failureCount).toBe(2);

      // Wait for rolling window to expire
      await new Promise(r => setTimeout(r, 60));

      // Old failures should be pruned
      expect(cb.getState().failureCount).toBe(0);

      // A single new failure shouldn't trip the breaker
      await expect(cb.execute(fn)).rejects.toThrow('fail');
      expect(cb.getState().state).toBe('CLOSED');
      expect(cb.getState().failureCount).toBe(1);
    });
  });

  describe('OPEN state (fail-fast)', () => {
    it('should reject calls immediately when OPEN', async () => {
      // Trip the breaker
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }
      expect(breaker.getState().state).toBe('OPEN');

      // Now calls should be rejected without invoking fn
      const fn2 = vi.fn().mockResolvedValue('ok');
      await expect(breaker.execute(fn2)).rejects.toThrow(CircuitBreakerError);
      expect(fn2).not.toHaveBeenCalled();
    });

    it('should include breaker name and state in CircuitBreakerError', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      try {
        await breaker.execute(vi.fn());
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitBreakerError);
        const cbe = err as CircuitBreakerError;
        expect(cbe.circuitBreakerName).toBe('test');
        expect(cbe.state).toBe('OPEN');
      }
    });

    it('should report nextRetryTime when OPEN', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      const snapshot = breaker.getState();
      expect(snapshot.nextRetryTime).not.toBeNull();
      expect(snapshot.nextRetryTime).toBeGreaterThan(Date.now() - 1);
    });
  });

  describe('HALF_OPEN state (recovery testing)', () => {
    it('should transition to HALF_OPEN after resetTimeout', async () => {
      // Trip the breaker
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }
      expect(breaker.getState().state).toBe('OPEN');

      // Wait for reset timeout
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));

      // Should now be HALF_OPEN (getState triggers the transition check)
      expect(breaker.getState().state).toBe('HALF_OPEN');
    });

    it('should allow limited concurrent calls in HALF_OPEN', async () => {
      // Trip the breaker
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(breaker.getState().state).toBe('HALF_OPEN');

      // First call should be allowed
      let resolveFirst: (v: string) => void;
      const firstCall = new Promise<string>(r => {
        resolveFirst = r;
      });
      const firstPromise = breaker.execute(() => firstCall);

      // Second concurrent call should be rejected (halfOpenMaxConcurrent = 1)
      await expect(breaker.execute(vi.fn())).rejects.toThrow(CircuitBreakerError);

      // Resolve the first call
      resolveFirst!('ok');
      await expect(firstPromise).resolves.toBe('ok');
    });

    it('should transition CLOSED after successThreshold successes in HALF_OPEN', async () => {
      // Trip, wait for HALF_OPEN
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(breaker.getState().state).toBe('HALF_OPEN');

      // Succeed successThreshold times
      const successFn = vi.fn().mockResolvedValue('ok');
      for (let i = 0; i < defaultConfig.successThreshold!; i++) {
        await breaker.execute(successFn);
      }

      expect(breaker.getState().state).toBe('CLOSED');
    });

    it('should transition back to OPEN on failure in HALF_OPEN', async () => {
      // Trip, wait for HALF_OPEN
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }

      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(breaker.getState().state).toBe('HALF_OPEN');

      // Fail in HALF_OPEN
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
      expect(breaker.getState().state).toBe('OPEN');
    });
  });

  describe('admin overrides', () => {
    it('reset() should return breaker to CLOSED', async () => {
      // Trip the breaker
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }
      expect(breaker.getState().state).toBe('OPEN');

      breaker.reset();
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().failureCount).toBe(0);

      // Should work again
      const successFn = vi.fn().mockResolvedValue('ok');
      await expect(breaker.execute(successFn)).resolves.toBe('ok');
    });

    it('trip() should force breaker to OPEN', async () => {
      expect(breaker.getState().state).toBe('CLOSED');
      breaker.trip();
      expect(breaker.getState().state).toBe('OPEN');

      await expect(breaker.execute(vi.fn())).rejects.toThrow(CircuitBreakerError);
    });

    it('reset() on already-CLOSED breaker should not fire callback', () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker({ ...defaultConfig, onStateChange: onChange });
      cb.reset();
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('onStateChange callback', () => {
    it('should fire callback on state transitions', async () => {
      const transitions: StateChangeEvent[] = [];
      const cb = new CircuitBreaker({
        ...defaultConfig,
        onStateChange: event => transitions.push(event),
      });

      // Trip the breaker
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(fn)).rejects.toThrow('fail');
      }

      expect(transitions).toHaveLength(1);
      expect(transitions[0].from).toBe('CLOSED');
      expect(transitions[0].to).toBe('OPEN');
      expect(transitions[0].name).toBe('test');
    });

    it('should not break the breaker if callback throws', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        onStateChange: () => {
          throw new Error('callback crash');
        },
      });

      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(fn)).rejects.toThrow('fail');
      }

      // Should still be OPEN despite callback crash
      expect(cb.getState().state).toBe('OPEN');
    });
  });

  describe('getState snapshot', () => {
    it('should return initial state', () => {
      const snapshot = breaker.getState();
      expect(snapshot.state).toBe('CLOSED');
      expect(snapshot.failureCount).toBe(0);
      expect(snapshot.halfOpenSuccessCount).toBe(0);
      expect(snapshot.lastFailureTime).toBeNull();
      expect(snapshot.lastSuccessTime).toBeNull();
      expect(snapshot.nextRetryTime).toBeNull();
      expect(snapshot.halfOpenActiveCount).toBe(0);
      expect(snapshot.totalCalls).toBe(0);
      expect(snapshot.failureRate).toBeNull();
    });

    it('should track lastSuccessTime and lastFailureTime', async () => {
      const successFn = vi.fn().mockResolvedValue('ok');
      await breaker.execute(successFn);
      expect(breaker.getState().lastSuccessTime).not.toBeNull();
      expect(breaker.getState().lastFailureTime).toBeNull();

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
      expect(breaker.getState().lastFailureTime).not.toBeNull();
    });

    it('should track totalCalls for successes and failures', async () => {
      const successFn = vi.fn().mockResolvedValue('ok');
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      await breaker.execute(successFn);
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');

      expect(breaker.getState().totalCalls).toBe(2);
    });
  });

  describe('failure rate threshold', () => {
    it('should not trip when failureRateThreshold is not configured (count-based only)', async () => {
      // Default breaker has no failureRateThreshold
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      // 2 failures + 8 successes = 20% failure rate
      for (let i = 0; i < 2; i++) {
        await expect(breaker.execute(failFn)).rejects.toThrow('fail');
      }
      for (let i = 0; i < 8; i++) {
        await breaker.execute(successFn);
      }

      // Should still be CLOSED; count-based threshold is 3
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().failureRate).toBeNull();
    });

    it('should not trip below minimumCalls even at 100% failure rate', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 100, // high count threshold so it won't trip by count
        failureRateThreshold: 0.5,
        minimumCalls: 10,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // 5 failures < minimumCalls of 10
      for (let i = 0; i < 5; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      expect(cb.getState().state).toBe('CLOSED');
      expect(cb.getState().failureRate).toBeNull();
    });

    it('should trip when rate exceeds threshold and minimumCalls met', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 100, // high count threshold so it won't trip by count
        failureRateThreshold: 0.5,
        minimumCalls: 10,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      // 4 successes + 6 failures = 60% failure rate (> 50% threshold)
      for (let i = 0; i < 4; i++) {
        await cb.execute(successFn);
      }
      for (let i = 0; i < 6; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      expect(cb.getState().state).toBe('OPEN');
    });

    it('should not trip when rate is below threshold', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 100,
        failureRateThreshold: 0.5,
        minimumCalls: 10,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      // 3 failures + 7 successes = 30% failure rate (< 50% threshold)
      for (let i = 0; i < 7; i++) {
        await cb.execute(successFn);
      }
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      expect(cb.getState().state).toBe('CLOSED');
    });

    it('should trip by count even when rate is below threshold (independent checks)', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 3,
        failureRateThreshold: 0.9, // high rate threshold
        minimumCalls: 10,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // 3 failures will trip by count (3/3 = 100% rate, but only 3 calls < minimumCalls of 10)
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      expect(cb.getState().state).toBe('OPEN');
    });

    it('should report correct totalCalls and failureRate', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 100,
        failureRateThreshold: 0.9, // high threshold so it won't trip
        minimumCalls: 5,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('ok');

      for (let i = 0; i < 3; i++) {
        await cb.execute(successFn);
      }
      for (let i = 0; i < 2; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      const snapshot = cb.getState();
      expect(snapshot.totalCalls).toBe(5);
      expect(snapshot.failureRate).toBeCloseTo(0.4);
    });

    it('should return null failureRate when below minimumCalls', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 100,
        failureRateThreshold: 0.5,
        minimumCalls: 10,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(cb.execute(failFn)).rejects.toThrow('fail');

      expect(cb.getState().failureRate).toBeNull();
    });

    it('should return null failureRate when failureRateThreshold not configured', async () => {
      const successFn = vi.fn().mockResolvedValue('ok');

      for (let i = 0; i < 15; i++) {
        await breaker.execute(successFn);
      }

      // breaker has no failureRateThreshold, so failureRate should be null
      expect(breaker.getState().failureRate).toBeNull();
    });

    it('should clear callTimestamps on reset()', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureRateThreshold: 0.5,
        minimumCalls: 5,
      });

      const successFn = vi.fn().mockResolvedValue('ok');
      for (let i = 0; i < 5; i++) {
        await cb.execute(successFn);
      }
      expect(cb.getState().totalCalls).toBe(5);

      cb.reset();
      expect(cb.getState().totalCalls).toBe(0);
    });
  });

  describe('concurrent execution in HALF_OPEN', () => {
    it('should respect halfOpenMaxConcurrent > 1', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        halfOpenMaxConcurrent: 2,
      });

      // Trip the breaker
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(cb.getState().state).toBe('HALF_OPEN');

      // Two concurrent calls should both be allowed
      let resolve1: (v: string) => void;
      let resolve2: (v: string) => void;
      const p1 = new Promise<string>(r => {
        resolve1 = r;
      });
      const p2 = new Promise<string>(r => {
        resolve2 = r;
      });

      const exec1 = cb.execute(() => p1);
      const exec2 = cb.execute(() => p2);

      // Third concurrent call should be rejected
      await expect(cb.execute(vi.fn())).rejects.toThrow(CircuitBreakerError);

      resolve1!('ok1');
      resolve2!('ok2');
      await expect(exec1).resolves.toBe('ok1');
      await expect(exec2).resolves.toBe('ok2');
    });
  });

  describe('full lifecycle transitions', () => {
    it('should complete full cycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      const transitions: string[] = [];
      const cb = new CircuitBreaker({
        ...defaultConfig,
        onStateChange: event => transitions.push(`${event.from}->${event.to}`),
      });

      // CLOSED -> OPEN
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }
      expect(cb.getState().state).toBe('OPEN');

      // OPEN -> HALF_OPEN
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(cb.getState().state).toBe('HALF_OPEN');

      // HALF_OPEN -> CLOSED
      const successFn = vi.fn().mockResolvedValue('ok');
      for (let i = 0; i < defaultConfig.successThreshold!; i++) {
        await cb.execute(successFn);
      }
      expect(cb.getState().state).toBe('CLOSED');

      expect(transitions).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
    });

    it('should complete cycle: CLOSED -> OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      const cb = new CircuitBreaker(defaultConfig);

      // Trip to OPEN
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      // Wait for HALF_OPEN
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(cb.getState().state).toBe('HALF_OPEN');

      // Fail again -> back to OPEN
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState().state).toBe('OPEN');

      // Wait again for HALF_OPEN
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(cb.getState().state).toBe('HALF_OPEN');

      // Succeed this time -> CLOSED
      const successFn = vi.fn().mockResolvedValue('ok');
      for (let i = 0; i < defaultConfig.successThreshold!; i++) {
        await cb.execute(successFn);
      }
      expect(cb.getState().state).toBe('CLOSED');
    });
  });

  describe('edge cases', () => {
    it('should handle non-Error throws gracefully', async () => {
      const cb = new CircuitBreaker(defaultConfig);

      const fn = vi.fn().mockRejectedValue('string error');
      await expect(cb.execute(fn)).rejects.toBe('string error');
      expect(cb.getState().failureCount).toBe(1);
    });

    it('should decrement halfOpenActiveCount even when function throws', async () => {
      const cb = new CircuitBreaker(defaultConfig);

      // Trip and wait for HALF_OPEN
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));

      // After the HALF_OPEN failure transitions back to OPEN, wait again
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState().state).toBe('OPEN');

      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      expect(cb.getState().state).toBe('HALF_OPEN');

      // halfOpenActiveCount should be 0, so a new call should be allowed
      expect(cb.getState().halfOpenActiveCount).toBe(0);
    });

    it('should not fire duplicate state change when trip() called while already OPEN', () => {
      const onChange = vi.fn();
      const cb = new CircuitBreaker({ ...defaultConfig, onStateChange: onChange });

      cb.trip();
      expect(onChange).toHaveBeenCalledTimes(1);

      cb.trip();
      // Should not fire again since it's already OPEN
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('should handle rapid successive calls correctly', async () => {
      const cb = new CircuitBreaker({
        ...defaultConfig,
        failureThreshold: 3,
      });

      // Fire 3 failures rapidly
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      await Promise.all([
        cb.execute(failFn).catch(() => {}),
        cb.execute(failFn).catch(() => {}),
        cb.execute(failFn).catch(() => {}),
      ]);

      expect(cb.getState().state).toBe('OPEN');
    });

    it('should clear failure history when transitioning from HALF_OPEN to CLOSED', async () => {
      const cb = new CircuitBreaker(defaultConfig);

      // Trip the breaker
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < defaultConfig.failureThreshold!; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      // Wait for HALF_OPEN and recover
      await new Promise(r => setTimeout(r, defaultConfig.resetTimeout! + 10));
      const successFn = vi.fn().mockResolvedValue('ok');
      for (let i = 0; i < defaultConfig.successThreshold!; i++) {
        await cb.execute(successFn);
      }

      expect(cb.getState().state).toBe('CLOSED');
      expect(cb.getState().failureCount).toBe(0);
      expect(cb.getState().totalCalls).toBe(0);
    });
  });
});

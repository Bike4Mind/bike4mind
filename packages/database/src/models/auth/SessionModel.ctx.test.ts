import { describe, it, expect } from 'vitest';
import { sessionRepository } from './SessionModel';

/**
 * `ctx` carries an explicit session into the queries that gate on it (`search`, the paged
 * listing). It used to be declared as a setter that assigned to itself, so every write recursed
 * until the stack blew - notebook import, its only caller, died on its first repository call with
 * "Maximum call stack size exceeded" before reaching any of its own logic.
 *
 * Null rather than a real ClientSession here on purpose: the queries only attach an explicit
 * session when `ctx` is truthy, so null is what leaves transactionAsyncLocalStorage in charge.
 */
describe('SessionRepository.ctx is assignable', () => {
  it('accepts a write without recursing', () => {
    const previous = sessionRepository.ctx;
    try {
      expect(() => {
        sessionRepository.ctx = null;
      }).not.toThrow();
    } finally {
      sessionRepository.ctx = previous;
    }
  });

  it('keeps what it was given', () => {
    const previous = sessionRepository.ctx;
    // A stand-in for a ClientSession: the field stores whatever it is handed, and the queries
    // only test it for truthiness.
    const marker = { id: 'stand-in-session' } as never;
    try {
      sessionRepository.ctx = marker;
      expect(sessionRepository.ctx).toBe(marker);
    } finally {
      sessionRepository.ctx = previous;
    }
  });

  it('defaults to null so an unset repository does not override ambient sessions', () => {
    // Guards the constructor initialising it: `.session(undefined)` and `.session(null)` both
    // defeat ALS propagation, and the query gate is `if (this.ctx)`.
    expect([null, undefined]).toContain(sessionRepository.ctx ?? null);
  });
});

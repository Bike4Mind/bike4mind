import { describe, expect, it, vi } from 'vitest';
import { SIGNED_IN_RESTART_MESSAGE, restartAfterSignIn } from './restartAfterSignIn.js';

describe('restartAfterSignIn', () => {
  it('releases the running session before it is rebuilt', async () => {
    const order: string[] = [];

    await restartAfterSignIn({
      release: async () => {
        order.push('release');
        return { shellsStopped: 0 };
      },
      restart: async () => void order.push('restart'),
      print: line => void order.push(line),
    });

    expect(order).toEqual(['release', SIGNED_IN_RESTART_MESSAGE, 'restart']);
    expect(SIGNED_IN_RESTART_MESSAGE).toBe('Signed in; starting a new session on Bike4Mind models.');
  });

  it("says the local session's background shells were stopped when there were any", async () => {
    const print = vi.fn();

    await restartAfterSignIn({ release: async () => ({ shellsStopped: 2 }), restart: async () => {}, print });

    expect(print).toHaveBeenCalledWith(
      `${SIGNED_IN_RESTART_MESSAGE} The local session's background shells (2) were stopped.`
    );
  });

  it('still restarts when releasing the old session fails', async () => {
    const restart = vi.fn(async () => {});

    await restartAfterSignIn({ release: async () => Promise.reject(new Error('boom')), restart, print: () => {} });

    expect(restart).toHaveBeenCalledOnce();
  });
});

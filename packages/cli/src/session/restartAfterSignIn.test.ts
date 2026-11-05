import { describe, expect, it, vi } from 'vitest';
import { SIGNED_IN_RESTART_MESSAGE, restartAfterSignIn } from './restartAfterSignIn.js';

describe('restartAfterSignIn', () => {
  it('releases the running session before it is rebuilt', async () => {
    const order: string[] = [];

    await restartAfterSignIn({
      release: async () => void order.push('release'),
      restart: async () => void order.push('restart'),
      print: line => void order.push(line),
    });

    expect(order).toEqual(['release', SIGNED_IN_RESTART_MESSAGE, 'restart']);
    expect(SIGNED_IN_RESTART_MESSAGE).toBe('Signed in; starting a new session on Bike4Mind models.');
  });

  it('still restarts when releasing the old session fails', async () => {
    const restart = vi.fn(async () => {});

    await restartAfterSignIn({ release: async () => Promise.reject(new Error('boom')), restart, print: () => {} });

    expect(restart).toHaveBeenCalledOnce();
  });
});

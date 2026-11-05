import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_STOP_TIMEOUT_MS, SIGNED_IN_RESTART_MESSAGE, restartAfterSignIn } from './restartAfterSignIn.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('restartAfterSignIn', () => {
  it('stops the running MCP servers before the session is rebuilt', async () => {
    const order: string[] = [];
    const mcpManager = { disconnect: vi.fn(async () => void order.push('disconnect')) };
    const print = vi.fn((line: string) => void order.push(line));

    await restartAfterSignIn({ mcpManager, restart: async () => void order.push('restart'), print });

    expect(mcpManager.disconnect).toHaveBeenCalledOnce();
    expect(order).toEqual(['disconnect', SIGNED_IN_RESTART_MESSAGE, 'restart']);
    expect(SIGNED_IN_RESTART_MESSAGE).toBe('Signed in; starting a new session on Bike4Mind models.');
  });

  it('still restarts when stopping the MCP servers fails', async () => {
    const restart = vi.fn(async () => {});
    const mcpManager = { disconnect: vi.fn(async () => Promise.reject(new Error('broken pipe'))) };

    await restartAfterSignIn({ mcpManager, restart, print: () => {} });

    expect(restart).toHaveBeenCalledOnce();
  });

  it('stops waiting on an MCP server that never closes', async () => {
    vi.useFakeTimers();
    const restart = vi.fn(async () => {});
    const mcpManager = { disconnect: () => new Promise<void>(() => {}) };

    const restarting = restartAfterSignIn({ mcpManager, restart, print: () => {} });
    await vi.advanceTimersByTimeAsync(MCP_STOP_TIMEOUT_MS);
    await restarting;

    expect(restart).toHaveBeenCalledOnce();
  });

  it('restarts without stopping anything when no MCP manager was built', async () => {
    const restart = vi.fn(async () => {});

    await restartAfterSignIn({ mcpManager: null, restart, print: () => {} });

    expect(restart).toHaveBeenCalledOnce();
  });
});

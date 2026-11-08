import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopTree } from './processTree';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function child() {
  const childProcess = new ChildProcess();
  // No real process is spawned or signalled by these tests.
  childProcess.kill = vi.fn(() => true);
  return childProcess;
}

describe('bounded process shutdown', () => {
  it('rejects after the kill grace when no exit event arrives', async () => {
    vi.useFakeTimers();
    const stopped = stopTree(child(), new Promise<never>(() => undefined), 100);
    const result = expect(stopped).rejects.toThrow('did not exit after SIGKILL');
    await vi.advanceTimersByTimeAsync(200);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the exit result and clears both timers when shutdown succeeds', async () => {
    vi.useFakeTimers();
    const exit = { code: 0 };
    await expect(stopTree(child(), Promise.resolve(exit), 100)).resolves.toEqual(exit);
    expect(vi.getTimerCount()).toBe(0);
  });
});

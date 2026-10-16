import { describe, expect, it, vi } from 'vitest';
import type { VaultFile } from '../auth/tokenVault';
import type { ActivityEvent } from './activityContract';
import { ActivityQueue } from './ActivityQueue';

const event: ActivityEvent = {
  eventId: 'event-000001',
  occurredAt: new Date().toISOString(),
  durationMs: 1000,
  type: 'session',
  sessionId: 'session-0001',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ActivityQueue ordering', () => {
  it('warns without file or event contents and recovers after a write failure', async () => {
    const warn = vi.fn();
    const file: VaultFile = {
      read: async () => '{invalid-json',
      write: vi.fn().mockRejectedValueOnce(new Error('private contents')).mockResolvedValue(undefined),
    };
    const queue = new ActivityQueue(file, Date.now, { warn });
    await queue.push([event]);
    await queue.clear();
    expect(warn.mock.calls).toEqual([
      ['FLEET: activity queue unreadable, starting empty'],
      ['FLEET: failed to write activity queue'],
    ]);
    expect(file.write).toHaveBeenLastCalledWith('[]');
  });

  it('loads once when startup size and push overlap', async () => {
    const read = deferred<string | null>();
    let contents: string | null = null;
    const file: VaultFile = {
      read: vi.fn(() => read.promise),
      write: async value => {
        contents = value;
      },
    };
    const queue = new ActivityQueue(file);
    const size = queue.size();
    const push = queue.push([event]);
    read.resolve('[]');
    await Promise.all([size, push]);
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(await queue.size()).toBe(1);
    expect(JSON.parse(contents!)).toEqual([event]);
  });

  it('persists clear after an in-flight push, including after restart', async () => {
    const writing = deferred<void>();
    let contents: string | null = null;
    const file: VaultFile = {
      read: async () => contents,
      write: vi.fn(async value => {
        if (value !== '[]') await writing.promise;
        contents = value;
      }),
    };
    const queue = new ActivityQueue(file);
    const push = queue.push([event]);
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(1));
    const clear = queue.clear();
    writing.resolve();
    await Promise.all([push, clear]);
    expect(contents).toBe('[]');
    expect(await new ActivityQueue(file).size()).toBe(0);
    expect(await queue.size()).toBe(0);
  });

  it('keeps clear last even when push is still loading', async () => {
    const read = deferred<string | null>();
    let contents: string | null = null;
    const file: VaultFile = {
      read: () => read.promise,
      write: async value => {
        contents = value;
      },
    };
    const queue = new ActivityQueue(file);
    const push = queue.push([event]);
    const clear = queue.clear();
    read.resolve('[]');
    await Promise.all([push, clear]);
    expect(contents).toBe('[]');
    expect(await queue.size()).toBe(0);
  });
});

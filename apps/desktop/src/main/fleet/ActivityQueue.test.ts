import { describe, expect, it, vi } from 'vitest';
import type { VaultFile } from '../auth/tokenVault';
import type { ActivityEvent } from './activityContract';
import { MAX_EVENT_AGE_MS } from './activityContract';
import { ActivityQueue, MAX_QUEUED_EVENTS } from './ActivityQueue';
import { memoryFile } from './memoryFile.testHelper';

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

const eventAt = (n: number, occurredAt = event.occurredAt): ActivityEvent => ({
  ...event,
  eventId: `event-${String(n).padStart(6, '0')}`,
  occurredAt,
});

describe('ActivityQueue persistence', () => {
  it('drops the oldest events first once past the cap, on disk as well as in memory', async () => {
    const file = memoryFile();
    const queue = new ActivityQueue(file);
    const all = Array.from({ length: MAX_QUEUED_EVENTS + 3 }, (_, i) => eventAt(i + 1));
    await queue.push(all.slice(0, MAX_QUEUED_EVENTS));
    await queue.push(all.slice(MAX_QUEUED_EVENTS));
    expect(await queue.size()).toBe(MAX_QUEUED_EVENTS);
    const onDisk = JSON.parse(file.contents!) as ActivityEvent[];
    expect(onDisk).toHaveLength(MAX_QUEUED_EVENTS);
    expect(onDisk[0].eventId).toBe('event-000004');
    expect(onDisk.at(-1)?.eventId).toBe(`event-${String(MAX_QUEUED_EVENTS + 3).padStart(6, '0')}`);
  });

  it.each(['{"events":[]}', '"text"', '42', 'null', '{not json', ''])(
    'loads %j as an empty queue and warns at most once',
    async contents => {
      const warn = vi.fn();
      const queue = new ActivityQueue(memoryFile(contents), Date.now, { warn });
      expect(await queue.size()).toBe(0);
      expect(await queue.peek()).toBeNull();
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    }
  );

  it('warns when the file is corrupt but stays quiet for a missing one', async () => {
    const warn = vi.fn();
    await new ActivityQueue(memoryFile('{not json'), Date.now, { warn }).size();
    expect(warn.mock.calls).toEqual([['FLEET: activity queue unreadable, starting empty']]);
    warn.mockClear();
    await new ActivityQueue(memoryFile(null), Date.now, { warn }).size();
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops events older than the maximum age in peek and persists the drop', async () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const stale = eventAt(1, new Date(now - MAX_EVENT_AGE_MS - 1000).toISOString());
    const fresh = eventAt(2, new Date(now - MAX_EVENT_AGE_MS + 60_000).toISOString());
    const file = memoryFile(JSON.stringify([stale, fresh]));
    const queue = new ActivityQueue(file, () => now);
    expect((await queue.peek())?.events).toEqual([fresh]);
    expect(JSON.parse(file.contents!)).toEqual([fresh]);
    expect(await queue.size()).toBe(1);
  });

  it('does not rewrite the file when peek finds nothing to drop', async () => {
    const file = memoryFile(JSON.stringify([event]));
    const write = vi.spyOn(file, 'write');
    await new ActivityQueue(file).peek();
    expect(write).not.toHaveBeenCalled();
  });

  it('removes only the given event ids and persists the rest', async () => {
    const file = memoryFile();
    const queue = new ActivityQueue(file);
    await queue.push([eventAt(1), eventAt(2), eventAt(3)]);
    await queue.remove(['event-000001', 'event-000003']);
    expect((JSON.parse(file.contents!) as ActivityEvent[]).map(e => e.eventId)).toEqual(['event-000002']);
  });

  it('the last-issued of overlapping push and clear wins on disk', async () => {
    const pushLast = memoryFile(null, true);
    const a = new ActivityQueue(pushLast);
    await Promise.all([a.clear(), a.push([eventAt(1)])]);
    expect(JSON.parse(pushLast.contents!)).toHaveLength(1);
    expect(await new ActivityQueue(pushLast).size()).toBe(1);

    const clearLast = memoryFile(null, true);
    const b = new ActivityQueue(clearLast);
    await Promise.all([b.push([eventAt(1)]), b.push([eventAt(2)]), b.clear()]);
    expect(clearLast.contents).toBe('[]');
    expect(await new ActivityQueue(clearLast).size()).toBe(0);
  });
});

describe('ActivityQueue ordering', () => {
  it('drops malformed disk entries while retaining valid activity', async () => {
    let contents = JSON.stringify([
      null,
      1,
      {},
      { ...event, type: 'repository' },
      { ...event, type: 'tool', tool: null },
      { ...event, usage: null },
      event,
    ]);
    const file: VaultFile = {
      read: async () => contents,
      write: async value => {
        contents = value;
      },
    };
    const queue = new ActivityQueue(file);
    expect((await queue.peek())?.events).toEqual([event]);
    expect(JSON.parse(contents)).toEqual([event]);
  });

  it('reports a failed clear and permits a successful retry before restart', async () => {
    let contents = JSON.stringify([event]);
    let fail = true;
    const file: VaultFile = {
      read: async () => contents,
      write: async value => {
        if (fail) throw new Error('disk unavailable');
        contents = value;
      },
    };
    const queue = new ActivityQueue(file, Date.now, { warn: () => undefined });
    await expect(queue.clear()).rejects.toThrow('Failed to clear activity queue');
    fail = false;
    await queue.clear();
    expect(await new ActivityQueue(file).size()).toBe(0);
  });

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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.send }));

import {
  MAX_PURGE_KEYS,
  MAX_PURGE_SESSION_IDS,
  buildGeneratedMediaPurgeMessages,
  enqueueGeneratedMediaPurge,
} from './generatedMediaPurgeQueue';

const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.send.mockResolvedValue('id');
});

describe('buildGeneratedMediaPurgeMessages', () => {
  it('chunks notebooks and keys, keeping every keys message under the size cap', () => {
    const sessionIds = Array.from({ length: MAX_PURGE_SESSION_IDS + 1 }, (_, i) => `s${i}`);
    const keys = Array.from({ length: 3000 }, (_, i) => `${'x'.repeat(200)}${i}.png`);
    const messages = buildGeneratedMediaPurgeMessages({ sessionIds, keys });
    const sessions = messages.filter(m => m.kind === 'sessions');
    const keyMessages = messages.filter(m => m.kind === 'keys');
    expect(sessions.map(m => m.sessionIds.length)).toEqual([MAX_PURGE_SESSION_IDS, 1]);
    expect(keyMessages.length).toBeGreaterThan(1);
    for (const m of keyMessages) expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(256 * 1024);
    expect(keyMessages.flatMap(m => m.keys)).toEqual(keys);
  });

  it('caps a keys message by count', () => {
    const keys = Array.from({ length: MAX_PURGE_KEYS + 1 }, (_, i) => `${i}`);
    expect(buildGeneratedMediaPurgeMessages({ keys }).map(m => (m.kind === 'keys' ? m.keys.length : 0))).toEqual([
      MAX_PURGE_KEYS,
      1,
    ]);
  });

  it('builds nothing for empty leftovers', () => {
    expect(buildGeneratedMediaPurgeMessages({ sessionIds: [], keys: [] })).toEqual([]);
  });
});

describe('enqueueGeneratedMediaPurge', () => {
  it('sends each message to the purge queue', async () => {
    await expect(enqueueGeneratedMediaPurge({ sessionIds: ['s1'], keys: ['a.png'] }, logger)).resolves.toBe(true);
    expect(h.send.mock.calls.map(([, body]) => body)).toEqual([
      { kind: 'sessions', sessionIds: ['s1'] },
      { kind: 'keys', keys: ['a.png'] },
    ]);
    expect(h.send.mock.calls[0][0]).toContain('generatedMediaPurgeQueue');
  });

  it('logs and returns false on a failed send without throwing', async () => {
    h.send.mockRejectedValueOnce(new Error('throttled'));
    await expect(enqueueGeneratedMediaPurge({ sessionIds: ['s1'], keys: ['a.png'] }, logger)).resolves.toBe(false);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
  });

  it('sends nothing for empty leftovers', async () => {
    await expect(enqueueGeneratedMediaPurge({}, logger)).resolves.toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { summarizeSession } from './sumarize';

describe('summarizeSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only { id, summary, summaryAt }', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const db = {
      sessions: {
        findByIdAndUserId: vi.fn().mockResolvedValue({
          id: 'session-1',
          name: 'kept off the write',
          firstCreated: new Date('2025-01-01T00:00:00Z'),
        }),
        update: vi.fn().mockResolvedValue(null),
      },
      chatHistories: {
        findAllBySessionIdAndCreatedAtGreaterThanDate: vi.fn().mockResolvedValue([{ prompt: 'q', reply: 'a' }]),
      },
    };
    const llm = { complete: vi.fn().mockResolvedValue('a fresh summary') };

    await summarizeSession('user-1', { id: 'session-1' }, { db, llm });

    expect(db.sessions.update).toHaveBeenCalledTimes(1);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({
      id: 'session-1',
      summary: 'a fresh summary',
      summaryAt: new Date('2026-01-01T00:00:00Z'),
    });
  });
});

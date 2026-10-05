import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { summarizeSession } from './sumarize';

describe('summarizeSession', () => {
  let db: {
    sessions: { findByIdAndUserId: Mock; update: Mock };
    chatHistories: { findAllBySessionIdAndCreatedAtGreaterThanDate: Mock };
  };
  let llm: { complete: Mock };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    db = {
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
    llm = { complete: vi.fn().mockResolvedValue('a fresh summary') };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only { id, summary, summaryAt }', async () => {
    await summarizeSession('user-1', { id: 'session-1' }, { db, llm });

    expect(db.sessions.update).toHaveBeenCalledTimes(1);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({
      id: 'session-1',
      summary: 'a fresh summary',
      summaryAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('does not write when the session is missing', async () => {
    db.sessions.findByIdAndUserId.mockResolvedValue(null);

    await expect(summarizeSession('user-1', { id: 'session-1' }, { db, llm })).rejects.toThrow(NotFoundError);

    expect(db.sessions.update).not.toHaveBeenCalled();
  });

  it('does not write when there is no new chat history', async () => {
    db.chatHistories.findAllBySessionIdAndCreatedAtGreaterThanDate.mockResolvedValue([]);

    await expect(summarizeSession('user-1', { id: 'session-1' }, { db, llm })).rejects.toThrow(
      UnprocessableEntityError
    );

    expect(llm.complete).not.toHaveBeenCalled();
    expect(db.sessions.update).not.toHaveBeenCalled();
  });
});

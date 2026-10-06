import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { generateTags } from './generateTags';

describe('generateTags', () => {
  const tags = [
    { name: 'alpha', strength: 3 },
    { name: 'beta', strength: 1 },
  ];

  let db: {
    sessions: { findByIdAndUserId: Mock; update: Mock };
    chatHistories: { findBySessionId: Mock };
  };
  let llm: { complete: Mock };

  beforeEach(() => {
    db = {
      sessions: {
        findByIdAndUserId: vi.fn().mockResolvedValue({ id: 'session-1', name: 'kept off the write' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      chatHistories: { findBySessionId: vi.fn().mockResolvedValue({ prompt: 'a prompt' }) },
    };
    llm = { complete: vi.fn().mockResolvedValue('```json\n' + JSON.stringify(tags) + '\n```') };
  });

  it('writes only { id, tags } parsed from a fenced JSON reply', async () => {
    await generateTags('user-1', { id: 'session-1' }, { db, llm });

    expect(db.sessions.update).toHaveBeenCalledTimes(1);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({ id: 'session-1', tags });
  });

  it('does not write when the session is missing', async () => {
    db.sessions.findByIdAndUserId.mockResolvedValue(null);

    await expect(generateTags('user-1', { id: 'session-1' }, { db, llm })).rejects.toThrow(NotFoundError);

    expect(db.sessions.update).not.toHaveBeenCalled();
  });

  it('does not write when the session has no chat history', async () => {
    db.chatHistories.findBySessionId.mockResolvedValue(null);

    await expect(generateTags('user-1', { id: 'session-1' }, { db, llm })).rejects.toThrow(UnprocessableEntityError);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(db.sessions.update).not.toHaveBeenCalled();
  });
});

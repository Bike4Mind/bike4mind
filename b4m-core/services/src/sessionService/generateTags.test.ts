import { describe, it, expect, vi } from 'vitest';
import { generateTags } from './generateTags';

describe('generateTags', () => {
  it('writes only { id, tags } parsed from a fenced JSON reply', async () => {
    const tags = [
      { name: 'alpha', strength: 3 },
      { name: 'beta', strength: 1 },
    ];
    const db = {
      sessions: {
        findByIdAndUserId: vi.fn().mockResolvedValue({ id: 'session-1', name: 'kept off the write' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      chatHistories: { findBySessionId: vi.fn().mockResolvedValue({ prompt: 'a prompt' }) },
    };
    const llm = { complete: vi.fn().mockResolvedValue('```json\n' + JSON.stringify(tags) + '\n```') };

    await generateTags('user-1', { id: 'session-1' }, { db, llm });

    expect(db.sessions.update).toHaveBeenCalledTimes(1);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({ id: 'session-1', tags });
  });
});

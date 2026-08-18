import { describe, it, expect, vi } from 'vitest';
import { snipSession } from './snip';

describe('snipSession', () => {
  const makeAdapters = () => {
    const created: Array<Record<string, unknown>> = [];
    return {
      db: {
        users: { findById: vi.fn().mockResolvedValue({ id: 'caller-1' }) },
        sessions: {
          findByIdAndUserId: vi.fn().mockResolvedValue({
            id: 'session-1',
            name: 'Original',
            knowledgeIds: [],
            tags: [],
          }),
          create: vi.fn().mockResolvedValue({ id: 'snip-1' }),
        },
        projects: {},
        fabFiles: {},
        chatHistories: {
          findBySessionIdAndId: vi.fn(),
          findAllBySessionIdAndGreaterThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockImplementation(async chat => {
            created.push(chat);
            return { id: 'new-msg-1', ...chat };
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
      } as any,
      created,
    };
  };

  it('snips messages from the snip point forward when the message belongs to the session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    const newSession = await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'm1');
    expect(newSession).toEqual({ id: 'snip-1' });
  });

  it('throws NotFoundError when the message does not exist', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce(null);

    await expect(snipSession('caller-1', { sessionId: 'session-1', messageId: 'missing' }, { db })).rejects.toThrow(
      'Message not found'
    );
  });

  // Regression for the same unbound-lookup shape #1755 fixed elsewhere: a bare findById(messageId)
  // would fetch a message from ANY session and use its timestamp to bound the snip's range query.
  // findBySessionIdAndId must reject a real message that belongs to a different session.
  it('throws NotFoundError when the message belongs to a different session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce(null);

    await expect(
      snipSession('caller-1', { sessionId: 'session-1', messageId: 'other-session-msg' }, { db })
    ).rejects.toThrow('Message not found');
    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'other-session-msg');
  });
});

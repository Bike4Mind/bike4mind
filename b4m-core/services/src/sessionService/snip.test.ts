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

  /**
   * Same reason as the fork case: a snip is a NEW session holding the source's lake files, so it must
   * carry the source's scope rather than re-derive it through the ownership arm alone (which cannot
   * see a teammate-authored organization-lake file, derives [], and an empty list reads downstream as
   * NO tag filter). Asserts the PERSISTED payload, so it also pins that secureParameters keeps the
   * field and that createSession's explicit-wins arm does not re-derive over it.
   */
  it('carries the source session retrievalTags onto the snip', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  it('snips messages from the snip point forward when the message belongs to the session', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndGreaterThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm2', sessionId: 'session-1', prompt: 'later' },
    ]);

    const newSession = await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'm1');
    expect(newSession).toEqual({ id: 'snip-1' });
    // the copied message drops its old id and is rebound to the new session
    expect(created).toEqual([{ sessionId: 'snip-1', prompt: 'later' }]);
  });

  // Same defect the fork 500 exposed: create() validates promptMeta.session.{id,userId} while the
  // live update() path does not, so a copied quest must bring its own session block.
  it('rebinds promptMeta.session to the snip and its caller, supplying it when absent', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndGreaterThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm2', sessionId: 'session-1', prompt: 'later', promptMeta: { warnings: ['partial coverage'] } },
      {
        id: 'm3',
        sessionId: 'session-1',
        prompt: 'later still',
        promptMeta: { session: { id: 'session-1', userId: 'other-user' } },
      },
    ]);

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(created[0].promptMeta).toEqual({
      warnings: ['partial coverage'],
      session: { id: 'snip-1', userId: 'caller-1' },
    });
    expect(created[1].promptMeta).toEqual({ session: { id: 'snip-1', userId: 'caller-1' } });
  });

  // findBySessionIdAndId returning null covers both "no such message" and "message belongs to a
  // different session" - the two are indistinguishable at this mocked layer (a real cross-session
  // pair is exercised at the repository level in QuestModel.findBySessionIdAndId.test.ts).
  it('throws NotFoundError when the message does not exist or belongs to a different session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce(null);

    await expect(snipSession('caller-1', { sessionId: 'session-1', messageId: 'missing' }, { db })).rejects.toThrow(
      'Message not found'
    );
    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'missing');
  });
});

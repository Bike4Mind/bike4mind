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

  /**
   * A snip keeps only the quests AFTER the snip point, so the quest the source tags were derived
   * from is usually gone from the copy. The copy must look untagged so the groom re-derives tags
   * from what the snip actually holds, even though the (possibly stale) tags themselves still copy.
   */
  it('does not carry taggedAt onto the snip', async () => {
    const { db } = makeAdapters();
    const taggedAt = new Date('2026-01-01T00:00:00.000Z');
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [{ name: 'racing', strength: 0.9 }],
      taggedAt,
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    const persisted = db.sessions.create.mock.calls[0][0];
    expect(persisted.taggedAt).toBeUndefined();
    expect(persisted.tags).toEqual([{ name: 'racing', strength: 0.9 }]);
  });

  /**
   * Unlike `taggedAt` above, the trigger DOES ride along: a snip deliberately keeps `summary` and
   * `summaryAt`, and the trigger is a claim about the same run on the source, so keeping two thirds
   * of the trio and dropping the third is the incoherent state.
   */
  it('carries the source session summaryTrigger onto the snip', async () => {
    const { db } = makeAdapters();
    const summaryAt = new Date('2026-01-01T00:00:00.000Z');
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      summary: 'the gist',
      summaryAt,
      summaryTrigger: 'contentGrowth',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'the gist', summaryAt, summaryTrigger: 'contentGrowth' })
    );
  });

  // A source summarized before the field existed must not come out of the copy carrying an invented
  // provenance; the copy passes the field through explicitly, so the key is present holding undefined.
  it('does not fabricate a summaryTrigger when the source has none', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      summary: 'the gist',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create.mock.calls[0][0].summaryTrigger).toBeUndefined();
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

  // See forkSession: a copied correction link would name a quest in the source session, and the
  // access checked at copy time is never rechecked when the pointer is later dereferenced.
  it('drops correctsQuestId rather than copying a link into the new session', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndGreaterThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm2', sessionId: 'session-1', prompt: 'a correction', correctsQuestId: 'quest-in-source-session' },
    ]);

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(created[0]).not.toHaveProperty('correctsQuestId');
    expect(created[0]).toEqual({ sessionId: 'snip-1', prompt: 'a correction' });
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

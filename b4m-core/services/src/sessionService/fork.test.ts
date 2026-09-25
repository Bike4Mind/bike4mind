import { describe, it, expect, vi } from 'vitest';
import { forkSession } from './fork';

describe('forkSession', () => {
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
          create: vi.fn().mockResolvedValue({ id: 'fork-1' }),
        },
        projects: {},
        fabFiles: {},
        chatHistories: {
          findBySessionIdAndId: vi.fn(),
          findAllBySessionIdAndLessThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
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
   * A fork is a NEW session holding the source's lake files, so it must carry the source's scope.
   * Re-deriving instead would run the OWNERSHIP arm alone (no resolveLakeAccess is threaded here),
   * which cannot see a teammate-authored organization-lake file - deriving [], and an empty list is
   * NOT a narrow scope: fabFileSearchQuery skips its tag clause, so the fork would silently ground
   * on every lake the caller can reach. Asserts the PERSISTED payload, so it also pins that
   * secureParameters keeps the field and that createSession's explicit-wins arm does not re-derive.
   */
  it('carries the source session retrievalTags onto the fork', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  /**
   * `taggedAt` is the companion timestamp of `tags`, same as `summaryAt` is of `summary`. A fork
   * that arrives without it looks untagged, so the spider re-tags it and overwrites the copied tags.
   */
  it('carries the source session taggedAt onto the fork', async () => {
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

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ taggedAt, tags: [{ name: 'racing', strength: 0.9 }] })
    );
  });

  /**
   * `summaryTrigger` is the WHY beside `summaryAt`'s WHEN. A fork already inherits the summary text
   * and its timestamp - both claims about a run on the SOURCE - so dropping the trigger leaves the
   * copy claiming a summary with no provenance, the exact state the admin summarization-spend view
   * exists to read.
   */

  /**
   * A decision-only trigger can no longer be published or stored, but a copy path must not be the
   * thing that discovers a document holding one: rejecting it in createSessionParametersSchema
   * would turn a stale row into a 422 that makes the notebook uncopyable. Drop the provenance,
   * keep the copy.
   */
  it('drops a decision-only summaryTrigger instead of failing the fork', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      summary: 'the gist',
      summaryTrigger: 'throttling',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create.mock.calls[0][0].summaryTrigger).toBeUndefined();
    expect(db.sessions.create.mock.calls[0][0].summary).toBe('the gist');
  });

  it('carries the source session summaryTrigger onto the fork', async () => {
    const { db } = makeAdapters();
    const summaryAt = new Date('2026-01-01T00:00:00.000Z');
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      summary: 'the gist',
      summaryAt,
      summaryTrigger: 'manual',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'the gist', summaryAt, summaryTrigger: 'manual' })
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

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create.mock.calls[0][0].summaryTrigger).toBeUndefined();
  });

  it('forks messages up to the fork point when the message belongs to the session', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndLessThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm0', sessionId: 'session-1', prompt: 'earlier' },
    ]);

    const newSession = await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'm1');
    expect(newSession).toEqual({ id: 'fork-1' });
    // the copied message drops its old id and is rebound to the new session
    expect(created).toEqual([{ sessionId: 'fork-1', prompt: 'earlier' }]);
  });

  // A correction link names a quest in the SOURCE session, so a copied one would dereference across
  // the session boundary - and the access that authorized this fork is never rechecked when the
  // pointer is later read. Same strip in clone.ts and snip.ts; read side re-checks in
  // resolveCorrectionContext (llm/buildCorrectionContext.ts).
  it('drops correctsQuestId rather than copying a link into the new session', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndLessThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm0', sessionId: 'session-1', prompt: 'a correction', correctsQuestId: 'quest-in-source-session' },
    ]);

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(created[0]).not.toHaveProperty('correctsQuestId');
    expect(created[0]).toEqual({ sessionId: 'fork-1', prompt: 'a correction' });
  });

  // Prod 500: "Quest validation failed: promptMeta.session.userId: Path `session.userId` is
  // required". Quests carrying promptMeta with no session block exist on disk (update() runs no
  // validators, several writers materialize promptMeta from nothing), and create() - the copy
  // path - does validate. See questPromptMetaSessionPersistence.test.ts for the store half.
  it('supplies promptMeta.session when the source quest carries none', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndLessThanOrEqualToTimestamp.mockResolvedValueOnce([
      { id: 'm0', sessionId: 'session-1', prompt: 'earlier', promptMeta: { warnings: ['partial coverage'] } },
    ]);

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(created[0].promptMeta).toEqual({
      warnings: ['partial coverage'],
      session: { id: 'fork-1', userId: 'caller-1' },
    });
  });

  // promptMeta.session.userId is the scoping key for deep research's internal quest search
  // (databaseSearcher.ts), so a copy that keeps the source pointer is searchable from the wrong
  // session and invisible from its own.
  it('rebinds a copied promptMeta.session to the fork and its caller', async () => {
    const { db, created } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
    db.chatHistories.findAllBySessionIdAndLessThanOrEqualToTimestamp.mockResolvedValueOnce([
      {
        id: 'm0',
        sessionId: 'session-1',
        prompt: 'earlier',
        promptMeta: { session: { id: 'session-1', userId: 'other-user', organizationId: 'org-1' } },
      },
    ]);

    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(created[0].promptMeta).toEqual({
      session: { id: 'fork-1', userId: 'caller-1', organizationId: 'org-1' },
    });
  });

  // findBySessionIdAndId returning null covers both "no such message" and "message belongs to a
  // different session" - the two are indistinguishable at this mocked layer (a real cross-session
  // pair is exercised at the repository level in QuestModel.findBySessionIdAndId.test.ts).
  it('throws NotFoundError when the message does not exist or belongs to a different session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce(null);

    await expect(forkSession('caller-1', { sessionId: 'session-1', messageId: 'missing' }, { db })).rejects.toThrow(
      'Message not found'
    );
    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'missing');
  });
});

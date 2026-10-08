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

  // `citationStyle` is create-only, so a snip that drops it is stuck on the 'named' default for good.
  it('carries the source session citationStyle onto the snip', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      citationStyle: 'indexed',
      corpusGroundingMode: 'retrieve',
      retrievalExcludeFilenameMarkers: ['draft'],
      retrievalVectorizedOnly: true,
      forceKnowledgeRetrieval: true,
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        citationStyle: 'indexed',
        corpusGroundingMode: 'retrieve',
        retrievalExcludeFilenameMarkers: ['draft'],
        retrievalVectorizedOnly: true,
      })
    );
  });

  // Create-only (not in SessionUpdateRequestSchema), so a snip that drops them can never get them back.
  it('carries the source session tool lists and systemPromptId onto the snip', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      enabledTools: ['web_search'],
      disabledTools: ['image_generation'],
      disableUserIntegrations: true,
      systemPromptId: 'triage_router',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledTools: ['web_search'],
        disabledTools: ['image_generation'],
        disableUserIntegrations: true,
        systemPromptId: 'triage_router',
      })
    );
  });

  /**
   * Pins `knowledgeIdsFromSourceSession`: the snip must copy the source's knowledgeIds without
   * re-running the access filter, which would drop a teammate-authored organization-lake file the
   * caller cannot independently resolve. Uses an ObjectId-shaped id so the id survives the earlier
   * ObjectId-shape drop and actually reaches the filter this test is pinning the opt-out of.
   */
  it('copies the source knowledgeIds without re-running the access filter', async () => {
    const { db } = makeAdapters();
    const FILE_ID = '507f1f77bcf86cd799439011';
    const findAccessibleInIds = vi.fn().mockResolvedValue([]);
    db.fabFiles = { findAccessibleInIds };
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [FILE_ID],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(findAccessibleInIds).not.toHaveBeenCalled();
    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ knowledgeIds: [FILE_ID] }));
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

  /**
   * A decision-only trigger can no longer be published or stored, but a copy path must not be the
   * thing that discovers a document holding one: rejecting it in createSessionParametersSchema
   * would turn a stale row into a 422 that makes the notebook uncopyable. Drop the provenance,
   * keep the copy.
   */
  it('drops a decision-only summaryTrigger instead of failing the snip', async () => {
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

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create.mock.calls[0][0].summaryTrigger).toBeUndefined();
    expect(db.sessions.create.mock.calls[0][0].summary).toBe('the gist');
  });

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

  // A snip made inside a product surface must stay in that surface's list, not drop into the main one.
  it('carries the source session surface onto the snip', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      surface: 'opti',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession(
      'caller-1',
      { sessionId: 'session-1', messageId: 'm1' },
      { db, resolveSurfaceAccess: async () => ({ entitlements: ['optihashi:pro'] }) }
    );

    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ surface: 'opti' }));
  });

  // E.g. the entitlement lapsed since the source was made: the snip must land where it can be opened.
  it('snips into the main list when the caller cannot use the registered source workspace', async () => {
    const { db } = makeAdapters();
    db.sessions.findByIdAndUserId.mockResolvedValueOnce({
      id: 'session-1',
      name: 'Original',
      knowledgeIds: [],
      tags: [],
      surface: 'opti',
    });
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession(
      'caller-1',
      { sessionId: 'session-1', messageId: 'm1' },
      { db, resolveSurfaceAccess: async () => ({ entitlements: [] }) }
    );

    expect(db.sessions.create.mock.calls[0][0].surface).toBeUndefined();
  });

  it('leaves the snip of a main-list session without a surface', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });

    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.sessions.create.mock.calls[0][0].surface).toBeUndefined();
  });

  describe('targetSurface', () => {
    const OPTI_ACCESS = async () => ({ entitlements: ['optihashi:pro'] });
    const NO_ACCESS = async () => ({ entitlements: [] });
    const snipFrom = async (
      surface: string | undefined,
      targetSurface: string | null | undefined,
      resolveSurfaceAccess?: () => Promise<{ entitlements: string[] }>
    ) => {
      const { db } = makeAdapters();
      db.sessions.findByIdAndUserId.mockResolvedValueOnce({
        id: 'session-1',
        name: 'Original',
        knowledgeIds: [],
        tags: [],
        surface,
      });
      db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', timestamp: new Date(10) });
      const run = snipSession(
        'caller-1',
        { sessionId: 'session-1', messageId: 'm1', targetSurface },
        { db, resolveSurfaceAccess }
      );
      return { db, run };
    };

    it('snips a main-list session into opti for an entitled caller', async () => {
      const { db, run } = await snipFrom(undefined, 'opti', OPTI_ACCESS);
      await run;
      expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ surface: 'opti' }));
    });

    // With access, so only an honored `null` target (not the no-entitlement fallback) yields no surface.
    it('snips an opti session into the main list', async () => {
      const { db, run } = await snipFrom('opti', null, OPTI_ACCESS);
      await run;
      expect(db.sessions.create.mock.calls[0][0].surface).toBeUndefined();
    });

    it('403s a destination the caller is not entitled to, creating nothing', async () => {
      const { db, run } = await snipFrom(undefined, 'opti', NO_ACCESS);
      await expect(run).rejects.toMatchObject({ statusCode: 403 });
      expect(db.sessions.create).not.toHaveBeenCalled();
    });

    it('400s an unregistered destination', async () => {
      const { db, run } = await snipFrom(undefined, 'some-private-surface', OPTI_ACCESS);
      await expect(run).rejects.toMatchObject({ statusCode: 400 });
      expect(db.sessions.create).not.toHaveBeenCalled();
    });

    it('400s a targeted snip out of an unregistered surface', async () => {
      const { db, run } = await snipFrom('some-private-surface', null, OPTI_ACCESS);
      await expect(run).rejects.toMatchObject({ statusCode: 400 });
      expect(db.sessions.create).not.toHaveBeenCalled();
    });

    // A copy without a target inherits even a surface this repo does not register.
    it('inherits an unregistered surface when no target is named', async () => {
      const { db, run } = await snipFrom('some-private-surface', undefined);
      await run;
      expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ surface: 'some-private-surface' }));
    });

    it('refuses a targeted snip when the route supplied no access resolver', async () => {
      const { db, run } = await snipFrom(undefined, 'opti');
      await expect(run).rejects.toMatchObject({ statusCode: 403 });
      expect(db.sessions.create).not.toHaveBeenCalled();
    });
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

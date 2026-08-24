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

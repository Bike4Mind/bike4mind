import { describe, it, expect, vi } from 'vitest';
import { cloneSession } from './clone';

/**
 * Regression for cgtorniado's 4th review: `findAccessibleById` matches on ownership OR a
 * share grant (users[]/groups[] read/write), so a read-only share holder can clone a session
 * and become the OWNER of the copy - reading promptMeta.functionCalls[].returnValue/.error
 * unredacted through the owner branch of every route this PR added redaction to. Only the
 * clone's OWNER field changes; the messages themselves must be redacted at copy time or the
 * share/subscribe boundary promptMetaRedaction.ts documents is bypassed entirely.
 */
describe('cloneSession - redaction at the copy boundary', () => {
  const makeAdapters = (sessionOwnerId: string) => {
    const created: Array<Record<string, unknown>> = [];
    return {
      db: {
        users: { findById: vi.fn().mockResolvedValue({ id: 'caller-1' }) },
        sessions: {
          shareable: {
            findAccessibleById: vi.fn().mockResolvedValue({
              id: 'session-1',
              userId: sessionOwnerId,
              name: 'Original',
              knowledgeIds: [],
              tags: [],
            }),
          },
          create: vi.fn().mockResolvedValue({ id: 'cloned-session-1' }),
        },
        projects: {},
        // A real reader: with `fabFiles: {}` the ownership arm threw a TypeError that the derivation
        // swallows, so anything asserting DERIVED scope passed for the wrong reason. Defaults to
        // "sees nothing"; individual tests override to model a readable shared lake file.
        fabFiles: {
          shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) },
          search: vi.fn().mockResolvedValue({ data: [] }),
        },
        chatHistories: {
          findAllBySessionId: vi.fn().mockResolvedValue([
            {
              id: 'msg-1',
              sessionId: 'session-1',
              promptMeta: {
                functionCalls: [
                  {
                    id: 'call-1',
                    name: 'web_search',
                    parameters: {},
                    returnValue: 'private tool output',
                    error: 'boom',
                  },
                ],
              },
            },
          ]),
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
   * Same reason as the fork case: a clone is a NEW session holding the source's lake files, so it must
   * carry the source's scope rather than re-derive it through the ownership arm alone (which cannot
   * see a teammate-authored organization-lake file, derives [], and an empty list reads downstream as
   * NO tag filter). Asserts the PERSISTED payload, so it also pins that secureParameters keeps the
   * field and that createSession's explicit-wins arm does not re-derive over it.
   */
  it('carries the source session retrievalTags onto the clone', async () => {
    const { db } = makeAdapters();
    db.sessions.shareable.findAccessibleById.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'caller-1',
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });

    await cloneSession('caller-1', { id: 'session-1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  /**
   * Same boundary as this file's docblock, one field further along: a share grant lets you READ the
   * source, not inherit its lake scope. The cloner may not reach that lake, and the explicit-wins arm
   * in createSession skips the derivation, so nothing on this path would check. Inheriting it would
   * narrow the clone to a lake it cannot read and switch off its personal-corpus fallback (a
   * non-empty retrievalTags reads as "already lake-scoped"), which the user cannot undo from the UI.
   */
  it('does NOT inherit the lake scope when the caller only holds a share', async () => {
    const { db } = makeAdapters('owner-1');
    db.sessions.shareable.findAccessibleById.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'owner-1', // caller-1 holds only a share
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });

    await cloneSession('caller-1', { id: 'session-1' }, { db });

    expect(db.sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  /**
   * The two halves together. The ownership gate routes a non-owner into the derivation rather than
   * letting them inherit the owner's tags; forwarding `resolveLakeAccess` is what gives that
   * derivation a reachability check. Each half is inert without the other, so both cases below are
   * asserted on the PERSISTED payload.
   */
  it('drops an inherited-looking lake tag when the share-holder cannot reach that lake', async () => {
    const { db } = makeAdapters('owner-1');
    db.sessions.shareable.findAccessibleById.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'owner-1', // caller-1 holds only a share
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });
    // The shared file IS readable by the cloner, so the ownership arm scrapes its lake tag...
    db.fabFiles.shareable.findAllAccessibleByIds.mockResolvedValueOnce([
      { id: 'f1', tags: [{ name: 'datalake:acme' }] },
    ]);
    // ...but the cloner reaches a different lake, so the intersection must discard it.
    const resolveLakeAccess = vi.fn().mockResolvedValue({
      dataLakeTags: ['datalake:other'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakeViewComplete: true,
    });

    await cloneSession('caller-1', { id: 'session-1' }, { db, resolveLakeAccess } as never);

    expect(resolveLakeAccess).toHaveBeenCalled();
    expect(db.sessions.create).toHaveBeenCalledWith(expect.not.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  it('keeps the derived lake tag when the share-holder CAN reach that lake', async () => {
    const { db } = makeAdapters('owner-1');
    db.sessions.shareable.findAccessibleById.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'owner-1',
      name: 'Original',
      knowledgeIds: ['f1'],
      tags: [],
      retrievalTags: ['datalake:acme'],
    });
    db.fabFiles.shareable.findAllAccessibleByIds.mockResolvedValueOnce([
      { id: 'f1', tags: [{ name: 'datalake:acme' }] },
    ]);
    const resolveLakeAccess = vi.fn().mockResolvedValue({
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakeViewComplete: true,
    });

    await cloneSession('caller-1', { id: 'session-1' }, { db, resolveLakeAccess } as never);

    expect(db.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ retrievalTags: ['datalake:acme'] }));
  });

  it('strips returnValue/error when the caller only holds a share, not ownership', async () => {
    const { db, created } = makeAdapters('owner-1');

    await cloneSession('caller-1', { id: 'session-1' }, { db });

    expect(created).toHaveLength(1);
    const clonedFunctionCalls = created[0].promptMeta.functionCalls;
    expect(clonedFunctionCalls[0]).not.toHaveProperty('returnValue');
    expect(clonedFunctionCalls[0]).not.toHaveProperty('error');
    expect(clonedFunctionCalls[0]).toMatchObject({ id: 'call-1', name: 'web_search' });
  });

  // Same store invariant the fork 500 exposed, plus the search-scoping half: a clone made by a
  // share holder becomes THEIR session, so promptMeta.session must name the clone and the cloner -
  // databaseSearcher.ts scopes deep research's internal quest search by promptMeta.session.userId.
  it('rebinds promptMeta.session to the clone and its new owner', async () => {
    const { db, created } = makeAdapters('owner-1');
    db.chatHistories.findAllBySessionId.mockResolvedValueOnce([
      {
        id: 'msg-1',
        sessionId: 'session-1',
        promptMeta: { session: { id: 'session-1', userId: 'owner-1', projectId: 'project-1' } },
      },
      { id: 'msg-2', sessionId: 'session-1', promptMeta: { warnings: ['partial coverage'] } },
      { id: 'msg-3', sessionId: 'session-1', prompt: 'no promptMeta at all' },
    ]);

    await cloneSession('caller-1', { id: 'session-1' }, { db });

    expect(created[0].promptMeta).toEqual({
      session: { id: 'cloned-session-1', userId: 'caller-1', projectId: 'project-1' },
    });
    expect(created[1].promptMeta).toEqual({
      warnings: ['partial coverage'],
      session: { id: 'cloned-session-1', userId: 'caller-1' },
    });
    // Nothing to rebind: a quest with no promptMeta must not be given one.
    expect(created[2].promptMeta).toBeUndefined();
  });

  it('keeps returnValue/error when the caller owns the session being cloned', async () => {
    const { db, created } = makeAdapters('caller-1');

    await cloneSession('caller-1', { id: 'session-1' }, { db });

    expect(created).toHaveLength(1);
    expect(created[0].promptMeta.functionCalls[0]).toMatchObject({
      returnValue: 'private tool output',
      error: 'boom',
    });
  });
});

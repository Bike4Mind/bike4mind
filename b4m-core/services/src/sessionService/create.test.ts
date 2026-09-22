import { describe, it, expect, vi, beforeEach } from 'vitest';

// createSession imports projectService from the services barrel ('..'); stub it so the
// heavy barrel is not loaded. addSessions is only reached when a projectId resolves, which
// these tests never do.
vi.mock('../projectService', () => ({ addSessions: vi.fn() }));

import { createSession } from './create';
import type { CreateSessionAdapters } from './create';
import type { IUserDocument } from '@bike4mind/common';
import { UnprocessableEntityError } from '@bike4mind/utils';

describe('createSession - agent object-level authz', () => {
  const user = { id: 'attacker' } as IUserDocument;

  // ObjectId-shaped on purpose: createSession drops non-ObjectId agentIds (usableSessionIds) before
  // the authz filter, so placeholder ids would be stripped ahead of findAllAccessibleByIds.
  const OWN_AGENT = '507f1f77bcf86cd799439101';
  const VICTIM_AGENT = '507f1f77bcf86cd799439102';
  const GROUP_SHARED_AGENT = '507f1f77bcf86cd799439103';

  // accessibleAgentIds: what shareable.findAllAccessibleByIds returns (owner + shares).
  const makeAdapters = (accessibleAgentIds: string[]) => {
    const create = vi.fn().mockResolvedValue({ id: 'session-1' });
    const findAllAccessibleByIds = vi.fn().mockResolvedValue(accessibleAgentIds.map(id => ({ id })));
    return {
      create,
      findAllAccessibleByIds,
      adapters: {
        db: {
          sessions: { create },
          projects: {},
          fabFiles: {},
          agents: { shareable: { findAllAccessibleByIds } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
        } as any,
      },
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('drops an agent id the caller cannot access, storing only accessible ones', async () => {
    // Caller supplies their own agent plus a victim's; only their own is accessible.
    const { create, adapters } = makeAdapters([OWN_AGENT]);

    await createSession(user, { name: 'S', agentIds: [OWN_AGENT, VICTIM_AGENT] }, adapters);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].agentIds).toEqual([OWN_AGENT]);
  });

  it('keeps a group-shared agent (no over-denial) while dropping a foreign one beside it', async () => {
    // findAllAccessibleByIds honors owner + user-shares + group-shares, so a group-shared
    // agent the caller does not own still resolves and is attached; a foreign id supplied
    // alongside it is filtered out.
    const { create, adapters } = makeAdapters([GROUP_SHARED_AGENT]);

    await createSession(user, { name: 'S', agentIds: [GROUP_SHARED_AGENT, VICTIM_AGENT] }, adapters);

    expect(create.mock.calls[0][0].agentIds).toEqual([GROUP_SHARED_AGENT]);
  });

  it('does not query the agents repo when no agentIds are supplied', async () => {
    const { create, findAllAccessibleByIds, adapters } = makeAdapters([]);

    await createSession(user, { name: 'S' }, adapters);

    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].agentIds).toEqual([]);
  });
});

/**
 * Lake-scope derivation at create time. The behavior under test is why an empty `retrievalTags` is
 * dangerous rather than merely unset: the search's tag clause is skipped entirely for an empty list,
 * so a session that names no lake retrieves against every lake its owner can reach.
 */
describe('createSession lake-scope derivation', () => {
  const user = { id: 'u1' } as IUserDocument;

  // ObjectId-shaped on purpose: createSession drops knowledgeIds that cannot address a row before
  // deriving, because findAllAccessibleByIds queries `_id: { $in: ... }` and a bad id throws there.
  const FILE_A = '507f1f77bcf86cd799439001';
  const FILE_B = '507f1f77bcf86cd799439002';
  const OTHER_FILE = '507f1f77bcf86cd799439003';

  const makeAdapters = (files: unknown[]) => {
    const findAllAccessibleByIds = vi.fn().mockResolvedValue(files);
    return {
      adapters: {
        db: {
          sessions: { create: vi.fn(async (d: unknown) => ({ id: 's1', ...(d as object) })) },
          projects: {} as never,
          fabFiles: { shareable: { findAllAccessibleByIds } } as never,
          agents: { shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) } } as never,
        },
      },
      findAllAccessibleByIds,
    };
  };

  const lakeFile = {
    id: FILE_A,
    tags: [{ name: 'datalake:acme' }, { name: 'acme:type:spec' }],
  };
  const personalFile = { id: FILE_B, tags: [{ name: 'notes' }] };

  it('derives the lake tag from the files a session is born holding', async () => {
    const { adapters } = makeAdapters([lakeFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_A] }, adapters as never);
    expect(session.retrievalTags).toEqual(['datalake:acme']);
  });

  it('derives nothing from personal files, so a personal notebook stays unscoped', async () => {
    const { adapters } = makeAdapters([personalFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_B] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });

  it('leaves an explicitly-resolved lake scope alone (resolveLakeSessionDefaults is authoritative)', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    const session = await createSession(
      user,
      { name: 'n', knowledgeIds: [FILE_A], retrievalTags: ['datalake:chosen'] },
      adapters as never
    );
    expect(session.retrievalTags).toEqual(['datalake:chosen']);
    // Not merely overridden - the derivation must not run at all, or it costs a DB read per create.
    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('derives nothing for an explicit scope that selected no lake', async () => {
    // A deliberate "no lakes" must survive the files the session is born holding - otherwise the
    // attachment hands back a scope the caller just cleared.
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    const session = await createSession(
      user,
      { name: 'n', knowledgeIds: [FILE_A], lakeScopeExplicit: true },
      adapters as never
    );
    expect(session.retrievalTags).toBeUndefined();
    expect(session.lakeScopeExplicit).toBe(true);
    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('skips the lookup entirely when no files are attached', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([]);
    await createSession(user, { name: 'n' }, adapters as never);
    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('resolves ids through the PERMISSION-FILTERED reader - knowledgeIds is client-writable', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    await createSession(user, { name: 'n', knowledgeIds: [FILE_A, OTHER_FILE] }, adapters as never);
    expect(findAllAccessibleByIds).toHaveBeenCalledWith(user, [FILE_A, OTHER_FILE]);
  });

  it('never fails session creation when the lake lookup throws', async () => {
    const { adapters } = makeAdapters([]);
    adapters.db.fabFiles.shareable.findAllAccessibleByIds = vi.fn().mockRejectedValue(new Error('boom'));
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_A] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });
});

// Shared by the knowledgeIds and taggedAt validation suites below: neither passes agentIds, so
// the authz pass-through behavior is interchangeable with a plain empty-array mock for both.
function makeAdapters() {
  const created: Record<string, unknown>[] = [];
  const adapters = {
    db: {
      sessions: {
        create: vi.fn(async (data: Record<string, unknown>) => {
          created.push(data);
          return { ...data, id: 'session-1' };
        }),
      },
      projects: {},
      fabFiles: { shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) } },
      // Authz pass-through: this suite isolates the usableSessionIds drop, so treat every
      // surviving agentId as accessible.
      agents: {
        shareable: { findAllAccessibleByIds: vi.fn(async (_u: unknown, ids: string[]) => ids.map(id => ({ id }))) },
      },
    },
  } as unknown as CreateSessionAdapters;
  return { adapters, created };
}

describe('createSession knowledgeIds validation', () => {
  const user = { id: '67cbd75e2415ca84138fada7' } as IUserDocument;
  const GOOD = '507f1f77bcf86cd799439011';

  it('accepts an ObjectId-shaped knowledgeId', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', knowledgeIds: [GOOD] }, adapters);
    expect(created[0].knowledgeIds).toEqual([GOOD]);
  });

  /**
   * Dropped, not rejected: /api/ai/llm forwards client-supplied fabFileIds straight into session
   * creation, so throwing here would fail the whole chat request over one unusable id.
   */
  it('drops an unusable knowledgeId and still creates', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', knowledgeIds: ['legacy-uuid-not-an-objectid', GOOD] }, adapters);
    expect(created[0].knowledgeIds).toEqual([GOOD]);
  });

  // agentIds references the same ObjectId-keyed collection and is client-supplied on this path,
  // so leaving it unguarded beside a guarded knowledgeIds was arbitrary.
  it('drops an unusable agentId too, not just knowledgeIds', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', agentIds: ['legacy-uuid-not-an-objectid', GOOD] }, adapters);
    expect(created[0].agentIds).toEqual([GOOD]);
  });

  it('leaves artifactIds alone, since those are a different id space', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', artifactIds: ['artifact_1756000000_ab12cd'] }, adapters);
    expect(created[0].artifactIds).toEqual(['artifact_1756000000_ab12cd']);
  });

  // Phase 3, regression case 4: preauthorizedLakeIds (manage-but-not-member admission) must never
  // enter createSession's own input - it is authorized and written as a SEPARATE call by the create
  // route, strictly after createSession returns (see pages/api/sessions/create.ts). A caller that
  // tries to pass it here - fork/snip/clone included, though none of them do today; they build their
  // own db.sessions.create() literal and never call this function at all - must not be able to
  // smuggle it in via a future refactor that forwards a source session's fields wholesale.
  //
  // The COMPILE-time half of this guarantee lives in create.ts
  // (CreateSessionParametersOmitPreauthorizedLakeIds), because tsconfig.json excludes test files:
  // a `@ts-expect-error` here would be in no typecheck program and could never fail. What this test
  // pins is the RUNTIME half - secureParameters strips the unknown key, so it never reaches the doc.
  it('strips preauthorizedLakeIds instead of persisting it', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(
      user,
      { name: 'ok', preauthorizedLakeIds: ['lake1'] } as unknown as Parameters<typeof createSession>[1],
      adapters
    );
    expect(created[0].preauthorizedLakeIds).toBeUndefined();
  });
});

/**
 * Forced retrieval implied by a declared lake scope. A session bound by `retrievalTags` +
 * `lakeScopeExplicit` reaches no lake-defaults merge (that is keyed on `dataLakeId` at the route),
 * so without this it was born with the flag unset and searched the lake only sometimes.
 */
describe('createSession forced retrieval from an explicit lake scope', () => {
  const user = { id: 'u1' } as IUserDocument;

  const makeAdapters = () => {
    const findAllAccessibleByIds = vi.fn().mockResolvedValue([]);
    return {
      adapters: {
        db: {
          sessions: { create: vi.fn(async (d: unknown) => ({ id: 's1', ...(d as object) })) },
          projects: {} as never,
          fabFiles: { shareable: { findAllAccessibleByIds } } as never,
          agents: { shareable: { findAllAccessibleByIds } } as never,
        },
      },
    };
  };

  it('turns forced retrieval on for a session scoped to a named lake', async () => {
    const { adapters } = makeAdapters();
    const session = await createSession(
      user,
      { name: 'n', retrievalTags: ['datalake:acme'], lakeScopeExplicit: true, retrievalVectorizedOnly: true },
      adapters as never
    );
    expect(session.forceKnowledgeRetrieval).toBe(true);
    // The fix must not cost the scoping correctness it builds on.
    expect(session.retrievalTags).toEqual(['datalake:acme']);
  });

  it('leaves an explicit opt-out off', async () => {
    const { adapters } = makeAdapters();
    const session = await createSession(
      user,
      { name: 'n', retrievalTags: ['datalake:acme'], lakeScopeExplicit: true, forceKnowledgeRetrieval: false },
      adapters as never
    );
    expect(session.forceKnowledgeRetrieval).toBe(false);
  });

  it('leaves the flag unset on an ordinary session that named no lake', async () => {
    const { adapters } = makeAdapters();
    const session = await createSession(user, { name: 'n' }, adapters as never);
    expect(session.forceKnowledgeRetrieval).toBeUndefined();
  });

  it('leaves the flag unset for an explicit scope that selected no lake', async () => {
    const { adapters } = makeAdapters();
    const session = await createSession(user, { name: 'n', lakeScopeExplicit: true }, adapters as never);
    expect(session.forceKnowledgeRetrieval).toBeUndefined();
  });
});

/** Pins both guarantees create.ts documents on `taggedAt`: kept by secureParameters, string form rejected. */
describe('createSession taggedAt validation', () => {
  const user = { id: '67cbd75e2415ca84138fada7' } as IUserDocument;

  it('rejects a string taggedAt instead of silently dropping it', async () => {
    const { adapters } = makeAdapters();
    await expect(
      createSession(
        user,
        { name: 'ok', taggedAt: '2026-05-01' } as unknown as Parameters<typeof createSession>[1],
        adapters
      )
    ).rejects.toThrow(UnprocessableEntityError);
  });

  it('carries a real Date taggedAt onto the persisted payload alongside its tags', async () => {
    const { adapters, created } = makeAdapters();
    const taggedAt = new Date('2026-05-01T00:00:00.000Z');
    await createSession(user, { name: 'ok', tags: [{ name: 'racing', strength: 0.9 }], taggedAt }, adapters);
    expect(created[0].tags).toEqual([{ name: 'racing', strength: 0.9 }]);
    expect(created[0].taggedAt).toEqual(taggedAt);
  });

  /**
   * A source can hold taggedAt with tags: [] (the update path accepts an empty array and never
   * clears the timestamp). Copying both as-is would persist a notebook that is already-tagged
   * but has nothing to show, so the spider's `!session.taggedAt` gate would skip it forever.
   */
  it('drops taggedAt when tags is empty or absent', async () => {
    const { adapters, created } = makeAdapters();
    const taggedAt = new Date('2026-05-01T00:00:00.000Z');
    await createSession(user, { name: 'empty-tags', tags: [], taggedAt }, adapters);
    await createSession(user, { name: 'no-tags', taggedAt }, adapters);
    expect(created[0].taggedAt).toBeUndefined();
    expect(created[1].taggedAt).toBeUndefined();
  });
});

/**
 * `summaryTrigger` is the provenance half of the summary trio (`summary`/`summaryAt`/trigger) that
 * clone/fork/snip carry. Pins both halves of the guarantee create.ts documents on it: kept by
 * secureParameters, and an out-of-enum value rejected rather than silently dropped - the Mongoose
 * write runs no validators, so this schema is the only thing standing between a bad trigger and a
 * stored document.
 */
describe('createSession summaryTrigger validation', () => {
  const user = { id: '67cbd75e2415ca84138fada7' } as IUserDocument;

  it('carries a summaryTrigger onto the persisted payload alongside its summary', async () => {
    const { adapters, created } = makeAdapters();
    const summaryAt = new Date('2026-05-01T00:00:00.000Z');
    await createSession(user, { name: 'ok', summary: 'the gist', summaryAt, summaryTrigger: 'manual' }, adapters);
    expect(created[0].summary).toBe('the gist');
    expect(created[0].summaryAt).toEqual(summaryAt);
    expect(created[0].summaryTrigger).toBe('manual');
  });

  it('rejects an out-of-enum summaryTrigger instead of silently dropping it', async () => {
    const { adapters } = makeAdapters();
    await expect(
      createSession(
        user,
        { name: 'ok', summaryTrigger: 'milestone' } as unknown as Parameters<typeof createSession>[1],
        adapters
      )
    ).rejects.toThrow(UnprocessableEntityError);
  });

  /**
   * 'throttling' is in the enum but is the one member no document may carry: shouldSummarizeSession
   * returns it as the reason it DECLINED to summarize. It stays assignable here because
   * ISessionDocument types the field with it, so only a runtime check can keep it off a write.
   */
  it('rejects the throttling trigger, which names a summarization that never happened', async () => {
    const { adapters } = makeAdapters();
    await expect(
      createSession(user, { name: 'ok', summary: 'the gist', summaryTrigger: 'throttling' }, adapters)
    ).rejects.toThrow(UnprocessableEntityError);
  });

  /**
   * Unlike `taggedAt`, an unpaired trigger is deliberately NOT scrubbed: `summaryAt` has no such
   * guard either, and a guard on one member of the trio alone would make the three inconsistent.
   */
  it('does not fabricate a summaryTrigger when the caller passes none', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'no-trigger', summary: 'the gist' }, adapters);
    expect(created[0].summaryTrigger).toBeUndefined();
  });
});

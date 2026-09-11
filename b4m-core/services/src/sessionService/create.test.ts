import { describe, it, expect, vi, beforeEach } from 'vitest';

// createSession imports projectService from the services barrel ('..'); stub it so the
// heavy barrel is not loaded. addSessions is only reached when a projectId resolves, which
// these tests never do.
vi.mock('..', () => ({
  projectService: { addSessions: vi.fn() },
}));

import { createSession } from './create';
import type { CreateSessionAdapters } from './create';
import type { IUserDocument } from '@bike4mind/common';

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

describe('createSession knowledgeIds validation', () => {
  const user = { id: '67cbd75e2415ca84138fada7' } as IUserDocument;
  const GOOD = '507f1f77bcf86cd799439011';

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

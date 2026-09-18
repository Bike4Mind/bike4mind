import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccessWithGrants: vi.fn(),
  canShredLakeMemory: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'caller-1', isAdmin: false })),
  readPrincipalMemory: vi.fn(),
  recall: vi.fn(() => []),
  shredPrincipalMemory: vi.fn(),
  shredBelief: vi.fn(),
  purgeUserMemory: vi.fn(),
  setLakeMemoryCursor: vi.fn(),
  stampLakeMemoryPurge: vi.fn(),
  findExistingIdsByIds: vi.fn(),
  logAuditEvent: vi.fn(),
}));

// baseApi mock: a callable chain routed by req.method (same shape as the lifecycle test). It does NOT
// wrap the handler in an error boundary, so a thrown access denial propagates out of the
// call - which is exactly how we assert that access denial is delegated to baseApi's onError (a 404).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  dataLakeRepository: {
    setLakeMemoryCursor: h.setLakeMemoryCursor,
    stampLakeMemoryPurge: h.stampLakeMemoryPurge,
  },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  deepAgentCharterRepository: {},
  fabFileRepository: { findExistingIdsByIds: h.findExistingIdsByIds },
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
  mementoRepository: {},
}));

vi.mock('@bike4mind/memory', () => ({
  firstMatchStore: vi.fn(() => ({ kind: 'firstMatch' })),
  mergeStores: vi.fn(() => ({ kind: 'merge' })),
  readPrincipalMemory: h.readPrincipalMemory,
  recall: h.recall,
  REDACTED_FACT: '[shredded]',
  subjectKey: (text: string) => `key:${text}`,
}));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccessWithGrants: h.assertLakeAccessWithGrants,
    canShredLakeMemory: h.canShredLakeMemory,
  },
}));

vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/auditLog', () => ({
  DataLakeAuditEvents: { LAKE_MEMORY_PURGED: 'LAKE_MEMORY_PURGED' },
  logAuditEvent: h.logAuditEvent,
}));
vi.mock('@server/dataLakes/resolveAuditPrincipal', () => ({ resolveAuditPrincipal: vi.fn(() => ({})) }));
vi.mock('@server/memory/deepAgentMemoryStore', () => ({ createDeepAgentMemoryStore: vi.fn(() => ({})) }));
vi.mock('@server/memory/personaAgentMemoryStore', () => ({ createPersonaAgentMemoryStore: vi.fn(() => ({})) }));
vi.mock('@server/memory/userMementoMemoryStore', () => ({ createUserMementoMemoryStore: vi.fn(() => ({})) }));
vi.mock('@server/memory/factCipher', () => ({ createKeyProvider: vi.fn(() => ({})) }));
vi.mock('@server/memory/ledgerMemoryStore', () => ({
  createLedgerMemoryStore: vi.fn(() => ({ readProfile: vi.fn() })),
  purgeUserMemory: h.purgeUserMemory,
  shredBelief: h.shredBelief,
  shredPrincipalMemory: h.shredPrincipalMemory,
}));

import handler from '../[id]';

type Handler = (req: unknown, res: unknown) => Promise<void>;
const invoke = handler as unknown as Handler;

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};

type ReqOpts = {
  method: 'GET' | 'DELETE';
  kind: string;
  id: string;
  user?: { id: string; isAdmin?: boolean } | undefined;
  subject?: string;
  q?: string;
};
/** The handler logs through `req.logger`, so it must be a real object or the fence-failure path throws. */
const makeLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() });
let lastLogger = makeLogger();
const makeReq = ({ method, kind, id, user = { id: 'caller-1' }, subject, q }: ReqOpts) => {
  lastLogger = makeLogger();
  return {
    method,
    query: { kind, id, ...(subject ? { subject } : {}), ...(q !== undefined ? { q } : {}) },
    user,
    logger: lastLogger,
  } as never;
};

const LAKE = { id: 'lake-1', datalakeTag: 'tag-abc', createdByUserId: 'creator-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: [] });
  h.toAccessContext.mockResolvedValue({ userId: 'caller-1', isAdmin: false });
  h.setLakeMemoryCursor.mockResolvedValue(undefined);
  h.stampLakeMemoryPurge.mockResolvedValue(undefined);
  h.logAuditEvent.mockResolvedValue(undefined);
  // Default: every cited source still exists, so the orphan filter is a no-op unless a test says so.
  // The reader answers with surviving IDS, not hydrated documents - existence is all this filter asks.
  h.findExistingIdsByIds.mockImplementation(async (ids: string[]) => ids);
});

describe('GET /api/memory/lake/:id - org-shared read', () => {
  it('reads the lake ledger under the creator key, keyed by datalakeTag (not the URL id)', async () => {
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [{ id: 'b1', fact: 'x', embedding: [0.1, 0.2] }] });
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    // The principal handed to the read is the lake's datalakeTag, never the URL id.
    expect(h.readPrincipalMemory).toHaveBeenCalledWith({ kind: 'lake', id: 'tag-abc' }, expect.anything());
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0];
    // The embedding is stripped before serialization.
    expect(payload.profile.beliefs[0]).not.toHaveProperty('embedding');
    expect(payload.profile.beliefs[0]).toMatchObject({ id: 'b1', fact: 'x' });
  });

  it('returns 404 for a static-registry (fallback) lake that has no creator/keyed ledger', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: { ...LAKE, createdByUserId: '' }, grants: [] });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.readPrincipalMemory).not.toHaveBeenCalled();
  });

  it('returns 404 when the lake has no memory profile yet', async () => {
    h.readPrincipalMemory.mockResolvedValue(null);
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('delegates an access denial to baseApi (the lake access gate throws -> propagates, becomes a 404)', async () => {
    h.assertLakeAccessWithGrants.mockRejectedValue(new Error('NotFound'));
    const { res } = makeRes();

    await expect(invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res)).rejects.toThrow('NotFound');
  });

  // The orphan filter. `purgeDataLakeDocument` destroys a source document without touching the beliefs
  // already distilled from it, so extracted content can outlive its only source - and no later purge
  // can reach it, because purges are keyed by source id.
  it('withholds a lake belief whose every cited source has been destroyed, and says how many', async () => {
    h.readPrincipalMemory.mockResolvedValue({
      beliefs: [
        { id: 'live', fact: 'still sourced', sources: ['doc-alive'] },
        { id: 'orphan', fact: 'from a destroyed doc', sources: ['doc-gone'] },
      ],
    });
    h.findExistingIdsByIds.mockResolvedValue(['doc-alive']);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0];
    expect(payload.profile.beliefs.map((b: { id: string }) => b.id)).toEqual(['live']);
    expect(payload.withheldOrphans).toBe(1);
  });

  it('keeps a belief with one surviving source among several destroyed ones', async () => {
    h.readPrincipalMemory.mockResolvedValue({
      beliefs: [{ id: 'partial', fact: 'x', sources: ['doc-gone', 'doc-alive'] }],
    });
    h.findExistingIdsByIds.mockResolvedValue(['doc-alive']);
    const { res, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    const payload = json.mock.calls[0][0];
    expect(payload.profile.beliefs).toHaveLength(1);
    expect(payload).not.toHaveProperty('withheldOrphans');
  });

  // A source-less belief is not an orphan: nothing was destroyed. Treating an empty list as evidence
  // of a purge would silently hide beliefs no purge ever touched.
  it('keeps a belief that cites no sources at all', async () => {
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [{ id: 'sourceless', fact: 'x' }] });
    h.findExistingIdsByIds.mockResolvedValue([]);
    const { res, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(json.mock.calls[0][0].profile.beliefs.map((b: { id: string }) => b.id)).toEqual(['sourceless']);
  });

  // The filter is lake-only: the owner-scoped kinds have no source-document lifecycle to orphan
  // against, and running it there would need a FabFile read that answers nothing.
  it('does not run the orphan filter for a non-lake principal', async () => {
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [{ id: 'b1', fact: 'x', sources: ['doc-gone'] }] });
    const { res, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'user', id: 'caller-1' }), res);

    expect(h.findExistingIdsByIds).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].profile.beliefs).toHaveLength(1);
  });

  it('filters the ?q recall arm too, not just the profile listing', async () => {
    const orphan = { id: 'orphan', fact: 'from a destroyed doc', sources: ['doc-gone'] };
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [orphan] });
    h.findExistingIdsByIds.mockResolvedValue([]);
    // recall() would happily surface the orphan; it must never be handed the withheld belief.
    h.recall.mockImplementation((beliefs: unknown[]) => beliefs.map(b => ({ belief: b, relevance: 0.9, score: 1 })));
    const { res, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1', q: 'destroyed' }), res);

    expect(h.recall).toHaveBeenCalledWith([], 'destroyed');
    expect(json.mock.calls[0][0].recalled).toEqual([]);
  });

  it('includes ACT-R recall when ?q is present', async () => {
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [{ id: 'b1', fact: 'x', embedding: [0.1] }] });
    h.recall.mockReturnValue([{ belief: { id: 'b1', fact: 'x', embedding: [0.1] }, relevance: 0.9, score: 1.2 }]);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1', q: 'anything' }), res);

    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0];
    expect(payload.query).toBe('anything');
    expect(payload.recalled[0].belief).not.toHaveProperty('embedding');
    expect(payload.recalled[0]).toMatchObject({ relevance: 0.9, score: 1.2 });
  });
});

describe('DELETE /api/memory/lake/:id - owner-gated crypto-shred', () => {
  it('whole-lake purge crypto-shreds the ledger for the creator, keyed by datalakeTag', async () => {
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(5);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(h.canShredLakeMemory).toHaveBeenCalledWith(
      { createdByUserId: 'creator-1' },
      { userId: 'creator-1', isAdmin: false },
      []
    );
    expect(h.shredPrincipalMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: 'lake', id: 'tag-abc' },
      'creator-1'
    );
    // Raises the purge FENCE, which both clears any interrupted continuation cursor and stops a build
    // that is running right now (the chain re-reads the stamp per document). Stamped AFTER the shred,
    // so a run that stops on the fence never does so while the old profile is still readable.
    expect(h.stampLakeMemoryPurge).toHaveBeenCalledWith('lake-1', expect.any(Date));
    expect(h.stampLakeMemoryPurge.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.shredPrincipalMemory.mock.invocationCallOrder[0]
    );
    expect(h.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.logAuditEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        userId: 'creator-1',
        action: 'LAKE_MEMORY_PURGED',
        metadata: expect.objectContaining({ dataLakeId: 'lake-1', shredded: 5 }),
      })
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, shredded: 5 });
  });

  it('a single ?subject shreds one belief (no memento twin - lake memory is pure ledger)', async () => {
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredBelief.mockResolvedValue(1);
    const { res, status, json } = makeRes();

    await invoke(
      makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', subject: 'belief-9', user: { id: 'creator-1' } }),
      res
    );

    expect(h.shredBelief).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'lake', id: 'tag-abc' },
      'creator-1',
      'belief-9'
    );
    expect(h.shredPrincipalMemory).not.toHaveBeenCalled();
    // A single-subject shred is NOT a whole-lake purge: no cursor reset, no purge audit event.
    expect(h.stampLakeMemoryPurge).not.toHaveBeenCalled();
    expect(h.logAuditEvent).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, shredded: 1, deleted: 1 });
  });

  it('passes active owner grants to the shred gate so a transferred owner can delete memory', async () => {
    const ownerGrants = [{ principalType: 'user', principalId: 'new-owner', role: 'owner' }];
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: ownerGrants });
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(2);
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'new-owner' } }), res);

    expect(h.canShredLakeMemory).toHaveBeenCalledWith(
      { createdByUserId: 'creator-1' },
      { userId: 'new-owner', isAdmin: false },
      ownerGrants
    );
    expect(status).toHaveBeenCalledWith(200);
  });

  it('a reader who is not the owner gets 403 (not 404 - they can see the lake) and no shred runs', async () => {
    h.canShredLakeMemory.mockReturnValue(false);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'not-creator' } }), res);

    expect(status).toHaveBeenCalledWith(403);
    // The copy is pinned, not incidental: it is what a denied caller reads, and naming the OWNER
    // rather than the creator is the half of this gate's widening that reaches a human.
    expect(json).toHaveBeenCalledWith({ error: 'Only the lake owner can delete its memory.' });
    expect(h.shredPrincipalMemory).not.toHaveBeenCalled();
    expect(h.shredBelief).not.toHaveBeenCalled();
  });

  it('an admin who is not the owner may shred (isAdmin flows into the shred check)', async () => {
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(2);
    const { res, status } = makeRes();

    await invoke(
      makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'admin-1', isAdmin: true } }),
      res
    );

    expect(h.canShredLakeMemory).toHaveBeenCalledWith(
      { createdByUserId: 'creator-1' },
      { userId: 'admin-1', isAdmin: true },
      []
    );
    expect(status).toHaveBeenCalledWith(200);
  });

  /**
   * The shred is irreversible before the fence is written, so a failed stamp must not be allowed to
   * throw out of the handler: that destroyed a key and left no audit record of it. One free retry (the
   * stamp is `$max` plus a constant `$set`, so it is idempotent), then the truth on both channels.
   */
  it('retries the fence stamp once, and a landing retry is an ordinary success', async () => {
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(3);
    h.stampLakeMemoryPurge.mockRejectedValueOnce(new Error('write concern timeout')).mockResolvedValueOnce(undefined);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(h.stampLakeMemoryPurge).toHaveBeenCalledTimes(2);
    expect(h.logAuditEvent.mock.calls[0][0].metadata).toEqual(expect.objectContaining({ fenceRaised: true }));
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, shredded: 3 });
  });

  it('audits the destruction and reports 500 with the truth when the fence cannot be raised at all', async () => {
    h.canShredLakeMemory.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(3);
    h.stampLakeMemoryPurge.mockRejectedValue(new Error('write concern timeout'));
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(h.stampLakeMemoryPurge).toHaveBeenCalledTimes(2);
    // The audit event lives OUTSIDE the fence guard: the erase happened, so it is recorded either way,
    // and `fenceRaised` is what tells an auditor which of the two halves landed.
    expect(h.logAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.logAuditEvent.mock.calls[0][0].metadata).toEqual(
      expect.objectContaining({ dataLakeId: 'lake-1', shredded: 3, fenceRaised: false })
    );
    expect(lastLogger.error).toHaveBeenCalledWith(expect.stringContaining('purge fence could not'));
    // Not a plain success (which would hide a lake left with a stale cursor) and not a plain failure
    // (which would invite the caller to think their data survived).
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ shredded: 3, fenceRaised: false, error: expect.stringContaining('Memory was erased') })
    );
  });

  it('returns 404 for a lake with no datalakeTag, before any shred runs', async () => {
    // The principal id IS the datalakeTag, and mongoose drops an `undefined` value out of a query
    // filter instead of matching on it - so an unguarded tag would turn this keyed crypto-shred into
    // `{ principalKind: 'lake' }` with no id, destroying every lake's key in the collection, other
    // tenants' included. extractLakeMemory and recallLakeMemoryForSession guard the same pair.
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: { ...LAKE, datalakeTag: undefined }, grants: [] });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.shredPrincipalMemory).not.toHaveBeenCalled();
    expect(h.canShredLakeMemory).not.toHaveBeenCalled();
  });

  it('returns 404 for a fallback lake before any manage check runs', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: { ...LAKE, createdByUserId: '' }, grants: [] });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.canShredLakeMemory).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    const { res, status } = makeRes();
    const unauthedReq = { method: 'DELETE', query: { kind: 'lake', id: 'lake-1' }, user: undefined } as never;

    await invoke(unauthedReq, res);

    expect(status).toHaveBeenCalledWith(401);
    expect(h.assertLakeAccessWithGrants).not.toHaveBeenCalled();
  });
});

describe('kind boundary + owner-scoped regression guards', () => {
  it('GET rejects an unsupported kind with 400', async () => {
    const { res, status } = makeRes();
    await invoke(makeReq({ method: 'GET', kind: 'bogus', id: 'x' }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('DELETE rejects an unsupported kind with 400', async () => {
    const { res, status } = makeRes();
    await invoke(makeReq({ method: 'DELETE', kind: 'bogus', id: 'x' }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('GET a user reads their own profile via the unified store (refactor guard)', async () => {
    h.readPrincipalMemory.mockResolvedValue({ beliefs: [] });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'user', id: 'caller-1' }), res);

    expect(h.readPrincipalMemory).toHaveBeenCalledWith({ kind: 'user', id: 'caller-1' }, expect.anything());
    expect(h.assertLakeAccessWithGrants).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
  });

  it('GET a user cannot read another user (403, no lake access path)', async () => {
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'user', id: 'someone-else' }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(h.readPrincipalMemory).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  canManageLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'caller-1', isAdmin: false })),
  readPrincipalMemory: vi.fn(),
  recall: vi.fn(() => []),
  shredPrincipalMemory: vi.fn(),
  shredBelief: vi.fn(),
  purgeUserMemory: vi.fn(),
}));

// baseApi mock: a callable chain routed by req.method (same shape as the lifecycle test). It does NOT
// wrap the handler in an error boundary, so a thrown assertLakeAccess denial propagates out of the
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
  dataLakeRepository: {},
  deepAgentCharterRepository: {},
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
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, canManageLake: h.canManageLake },
}));

vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
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
const makeReq = ({ method, kind, id, user = { id: 'caller-1' }, subject, q }: ReqOpts) =>
  ({ method, query: { kind, id, ...(subject ? { subject } : {}), ...(q !== undefined ? { q } : {}) }, user }) as never;

const LAKE = { id: 'lake-1', datalakeTag: 'tag-abc', createdByUserId: 'creator-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.toAccessContext.mockResolvedValue({ userId: 'caller-1', isAdmin: false });
});

describe('GET /api/memory/lake/:id - org-shared read', () => {
  it('reads the lake ledger under the creator key, keyed by datalakeTag (not the URL id)', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
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
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, createdByUserId: '' });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.readPrincipalMemory).not.toHaveBeenCalled();
  });

  it('returns 404 when the lake has no memory profile yet', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
    h.readPrincipalMemory.mockResolvedValue(null);
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('delegates an access denial to baseApi (assertLakeAccess throws -> propagates, becomes a 404)', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('NotFound'));
    const { res } = makeRes();

    await expect(invoke(makeReq({ method: 'GET', kind: 'lake', id: 'lake-1' }), res)).rejects.toThrow('NotFound');
  });

  it('includes ACT-R recall when ?q is present', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
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

describe('DELETE /api/memory/lake/:id - manage-gated crypto-shred', () => {
  it('whole-lake purge crypto-shreds the ledger for the creator, keyed by datalakeTag', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
    h.canManageLake.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(5);
    const { res, status, json } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(h.canManageLake).toHaveBeenCalledWith(
      { createdByUserId: 'creator-1' },
      { userId: 'creator-1', isAdmin: false }
    );
    expect(h.shredPrincipalMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: 'lake', id: 'tag-abc' },
      'creator-1'
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, shredded: 5 });
  });

  it('a single ?subject shreds one belief (no memento twin - lake memory is pure ledger)', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
    h.canManageLake.mockReturnValue(true);
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
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, shredded: 1, deleted: 1 });
  });

  it('a reader who is not the creator gets 403 (not 404 - they can see the lake) and no shred runs', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
    h.canManageLake.mockReturnValue(false);
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'not-creator' } }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(h.shredPrincipalMemory).not.toHaveBeenCalled();
    expect(h.shredBelief).not.toHaveBeenCalled();
  });

  it('an admin who is not the creator may shred (isAdmin flows into the manage check)', async () => {
    h.assertLakeAccess.mockResolvedValue(LAKE);
    h.canManageLake.mockReturnValue(true);
    h.shredPrincipalMemory.mockResolvedValue(2);
    const { res, status } = makeRes();

    await invoke(
      makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'admin-1', isAdmin: true } }),
      res
    );

    expect(h.canManageLake).toHaveBeenCalledWith(
      { createdByUserId: 'creator-1' },
      { userId: 'admin-1', isAdmin: true }
    );
    expect(status).toHaveBeenCalledWith(200);
  });

  it('returns 404 for a fallback lake before any manage check runs', async () => {
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, createdByUserId: '' });
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'DELETE', kind: 'lake', id: 'lake-1', user: { id: 'creator-1' } }), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.canManageLake).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    const { res, status } = makeRes();
    const unauthedReq = { method: 'DELETE', query: { kind: 'lake', id: 'lake-1' }, user: undefined } as never;

    await invoke(unauthedReq, res);

    expect(status).toHaveBeenCalledWith(401);
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
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
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
  });

  it('GET a user cannot read another user (403, no lake access path)', async () => {
    const { res, status } = makeRes();

    await invoke(makeReq({ method: 'GET', kind: 'user', id: 'someone-else' }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(h.readPrincipalMemory).not.toHaveBeenCalled();
  });
});

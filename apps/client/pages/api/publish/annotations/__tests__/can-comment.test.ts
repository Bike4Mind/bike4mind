import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET /api/publish/annotations/[publicId]/can-comment - must answer the same plain 404 as the
 * serve route and the list when the artifact's owner is deleted, banned or suspended, so it
 * cannot confirm such a page exists or leak its comment policy.
 */

const mocks = vi.hoisted(() => ({
  artifactLean: vi.fn(),
  loadLiveOwner: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, get: (fn: object) => fn });
    return chain;
  },
}));
vi.mock('@server/middlewares/optionalAuth', () => ({ optionalAuth: () => {} }));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: () => ({ select: () => ({ lean: mocks.artifactLean }) }) },
}));
vi.mock('@server/services/publish', () => ({
  checkVisibility: vi.fn(async () => ({ ok: true })),
  canAnnotate: () => false,
  toPublishUser: () => undefined,
  requestHasGateProof: () => false,
  loadLiveOwner: mocks.loadLiveOwner,
}));

import handler from '../[publicId]/can-comment';

type Res = {
  statusCode: number;
  body: unknown;
  setHeader: (k: string, v: string) => void;
  status: (c: number) => Res;
  json: (o: unknown) => Res;
};

function makeRes(): Res {
  const res = { statusCode: 0, body: undefined } as unknown as Res;
  res.setHeader = () => {};
  res.status = c => {
    res.statusCode = c;
    return res;
  };
  res.json = o => {
    res.body = o;
    return res;
  };
  return res;
}

const run = (): Promise<Res> => {
  const res = makeRes();
  const req = { query: { publicId: 'pub1' }, user: undefined, headers: {}, cookies: {} };
  return (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res).then(() => res);
};

describe('GET can-comment - owner check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactLean.mockResolvedValue({
      publicId: 'pub1',
      visibility: 'public',
      ownerId: 'o1',
      scopeId: 's1',
      commentPolicy: 'open',
      accessGate: null,
    });
  });

  it('answers for a live owner', async () => {
    mocks.loadLiveOwner.mockResolvedValue({ name: 'Owner' });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ commentPolicy: 'open', canComment: false });
  });

  it('404s when the owner account is gone, banned or suspended', async () => {
    mocks.loadLiveOwner.mockResolvedValue(null);

    const res = await run();

    expect(res.statusCode).toBe(404);
    expect(mocks.loadLiveOwner).toHaveBeenCalledWith('o1');
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

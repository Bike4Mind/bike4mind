import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route tests for POST /api/publish/view - the signed-in view report that feeds the Published
 * gear's payout. The surface is "whose view counts", so every refusal is asserted to leave
 * externalViewCount untouched: a leak here is a self-grant of the gear's credits.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findOne: vi.fn(),
    lean: vi.fn(),
    updateOne: vi.fn(() => Promise.resolve({})),
    parse: vi.fn(),
    checkVisibility: vi.fn(),
    checkShareGrant: vi.fn(),
    hasGateProof: vi.fn(() => false),
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@server/middlewares/optionalJwtAuth', () => ({
  optionalJwtAuth: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (...a: unknown[]) => {
      mocks.findOne(...a);
      return { select: () => ({ lean: () => Promise.resolve(mocks.lean()) }) };
    },
    updateOne: (...a: unknown[]) => mocks.updateOne(...a),
  },
  shareTokenFilter: (token: string) => ({ __shareFilterFor: token }),
}));
vi.mock('@server/services/publish', () => ({
  checkVisibility: (...a: unknown[]) => mocks.checkVisibility(...a),
  checkShareGrant: (...a: unknown[]) => mocks.checkShareGrant(...a),
  toPublishUser: (u?: { id?: string }) => (u?.id ? { id: u.id } : undefined),
}));
vi.mock('@server/services/publish/parsePublishPath', () => ({
  segmentsFromViewerPathname: (p: string) => (p === '/bad' ? null : ['u', 'scope', 'slug']),
  parsePublishPath: (...a: unknown[]) =>
    mocks.parse(...a) ?? { kind: 'bundle', tier: 'user', scopeId: 'scope', slug: 'slug', assetPath: null },
}));
vi.mock('@server/services/publish/publishGateToken', () => ({
  requestHasGateProof: (...a: unknown[]) => mocks.hasGateProof(...a),
}));

import handler from '../view';

type Principal = { id: string; mfaPending?: boolean; oauthGrant?: { scopes: string[]; clientId: string } } | undefined;

const run = (body: unknown, user: Principal) => {
  const { req, res } = createMocks({ method: 'POST', body });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** An open-public bundle owned by `owner1`. */
const published = (over: Record<string, unknown> = {}) =>
  mocks.lean.mockReturnValue({
    publicId: 'pub1',
    ownerId: 'owner1',
    scopeId: 'scope',
    visibility: 'public',
    accessGate: null,
    ...over,
  });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.updateOne.mockResolvedValue({});
  mocks.hasGateProof.mockReturnValue(false);
  mocks.checkVisibility.mockResolvedValue({ ok: true });
  mocks.checkShareGrant.mockResolvedValue({ ok: true });
});

describe('POST /api/publish/view - whose view counts', () => {
  it('counts a signed-in non-owner as one external view, leaving viewCount to the navigation', async () => {
    published();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'friend' });
    await promise;

    expect(res._getStatusCode()).toBe(204);
    expect(mocks.updateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { externalViewCount: 1 } });
  });

  it('does not count the owner opening their own page', async () => {
    published();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(204);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller without looking the artifact up', async () => {
    published();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, undefined);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('treats a pre-MFA session as anonymous', async () => {
    published();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'friend', mfaPending: true });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('treats a relying-party OAuth token as anonymous', async () => {
    published();

    const { res, promise } = run(
      { path: '/p/u/scope/slug' },
      { id: 'friend', oauthGrant: { scopes: ['openid'], clientId: 'c1' } }
    );
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('does not count a viewer the page would have refused, and says only "not found"', async () => {
    published({ visibility: 'org' });
    mocks.checkVisibility.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'stranger' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('passes a passphrase proof cookie through to the gate check', async () => {
    published({ accessGate: { kind: 'passphrase' } });
    mocks.hasGateProof.mockReturnValue(true);

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'friend' });
    await promise;

    expect(mocks.checkVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ accessGate: { kind: 'passphrase' } }),
      { id: 'friend' },
      { passphraseVerified: true }
    );
    expect(res._getStatusCode()).toBe(204);
    expect(mocks.updateOne).toHaveBeenCalled();
  });

  it('admits a share link through the share grant, not the visibility ladder', async () => {
    mocks.parse.mockReturnValue({ kind: 'share', shareToken: 'tok123', assetPath: null });
    published({ visibility: 'private' });

    const { res, promise } = run({ path: '/a/tok123' }, { id: 'friend' });
    await promise;

    expect(mocks.findOne).toHaveBeenCalledWith({ __shareFilterFor: 'tok123', deletedAt: null });
    expect(mocks.checkShareGrant).toHaveBeenCalled();
    expect(mocks.checkVisibility).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(204);
    expect(mocks.updateOne).toHaveBeenCalledWith({ publicId: 'pub1' }, { $inc: { externalViewCount: 1 } });
  });

  it('does not count a share-link viewer the share grant refuses', async () => {
    mocks.parse.mockReturnValue({ kind: 'share', shareToken: 'tok123', assetPath: null });
    published({ visibility: 'private', accessGate: { kind: 'domain', allowedDomains: ['example.com'] } });
    mocks.checkShareGrant.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden', reason: 'domain' });

    const { res, promise } = run({ path: '/a/tok123' }, { id: 'stranger' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('404s an unknown artifact', async () => {
    mocks.lean.mockReturnValue(null);

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'friend' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('404s a path that is not a viewer page', async () => {
    const { res, promise } = run({ path: '/bad' }, { id: 'friend' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it('400s a missing path', async () => {
    const { res, promise } = run({}, { id: 'friend' });
    await promise;

    expect(res._getStatusCode()).toBe(400);
  });
});

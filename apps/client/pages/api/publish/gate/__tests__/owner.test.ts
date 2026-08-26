import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route tests for POST /api/publish/gate/owner - a new authorization decision point that mints
 * the passphrase proof cookie on identity alone. Five outcomes (400/401/403/404/204), and the
 * whole surface is "who does the server admit", so it is asserted here rather than in the shell
 * tests, which stub this route's status codes as inputs.
 *
 * The mfaPending case is the one to keep: this route is `auth: false`, so the full-auth chain's
 * mfaPending gate never runs, and optionalAuth (unlike optionalJwtAuth) does not filter it -
 * the JWT strategy stamps mfaPending onto req.user and returns SUCCESS. Without an explicit
 * check, a first-factor-only session would walk away with a 2-hour credential-free proof cookie.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { findOne: vi.fn(), select: vi.fn(), lean: vi.fn(), setCookie: vi.fn(() => true) },
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock('@server/middlewares/optionalAuth', () => ({ optionalAuth: (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (...a: unknown[]) => {
      mocks.findOne(...a);
      return {
        select: (s: string) => {
          mocks.select(s);
          return { lean: () => Promise.resolve(mocks.lean()) };
        },
      };
    },
  },
}));
vi.mock('@server/services/publish/parsePublishPath', () => ({
  segmentsFromViewerPathname: (p: string) => (p === '/bad' ? null : ['u', 'scope', 'slug']),
  parsePublishPath: () => ({ kind: 'bundle', tier: 'user', scopeId: 'scope', slug: 'slug', assetPath: null }),
}));
vi.mock('@server/services/publish/publishGateToken', () => ({
  setGateProofCookie: (...a: unknown[]) => mocks.setCookie(...a),
}));

import handler from '../owner';

type Principal = { id: string; isAdmin?: boolean; mfaPending?: boolean } | undefined;

const run = (body: unknown, user: Principal) => {
  const { req, res } = createMocks({ method: 'POST', body });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** A passphrase-gated artifact owned by `owner1`. */
const gated = (over: Record<string, unknown> = {}) =>
  mocks.lean.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', accessGate: { kind: 'passphrase' }, ...over });

beforeEach(() => {
  Object.values(mocks).forEach(m => (m as { mockReset?: () => void }).mockReset?.());
  mocks.setCookie.mockReturnValue(true);
});

describe('POST /api/publish/gate/owner - who is admitted', () => {
  it('mints the proof cookie for the owner', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(204);
    expect(mocks.setCookie).toHaveBeenCalledWith(expect.anything(), 'pub1');
  });

  it('mints for an admin who is not the owner', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'someone', isAdmin: true });
    await promise;

    expect(res._getStatusCode()).toBe(204);
  });

  it('403s a signed-in non-owner, minting nothing', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'stranger' });
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller without even looking the artifact up', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, undefined);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  // THE REGRESSION GUARD. This route is `auth: false`, so auth.ts's mfaPending gate never runs,
  // and optionalAuth does not filter mfaPending the way optionalJwtAuth does. An admitted
  // pre-MFA session would receive a 2-hour proof cookie that needs no credential thereafter and
  // carries no identity, so a tokenVersion bump could not revoke it.
  it('401s a pre-MFA (mfaPending) session even when it IS the owner', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1', mfaPending: true });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it('401s a pre-MFA admin, who would otherwise unlock every gated artifact', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'root', isAdmin: true, mfaPending: true });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});

describe('POST /api/publish/gate/owner - what is refused', () => {
  it('400s a missing or malformed body', async () => {
    const { res, promise } = run({}, { id: 'owner1' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
  });

  it('404s an unresolvable path', async () => {
    gated();

    const { res, promise } = run({ path: '/bad' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
  });

  it('404s an artifact that does not exist', async () => {
    mocks.lean.mockResolvedValue(null);

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
  });

  it('404s an UNGATED artifact, so the route confirms nothing about gating', async () => {
    gated({ accessGate: null });

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it('404s a DOMAIN-gated artifact - this route only answers for passphrase gates', async () => {
    gated({ accessGate: { kind: 'domain' } });

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(404);
  });

  it('500s rather than 204s when the cookie cannot be set', async () => {
    gated();
    mocks.setCookie.mockReturnValue(false);

    const { res, promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    expect(res._getStatusCode()).toBe(500);
  });
});

describe('POST /api/publish/gate/owner - projection', () => {
  it('never loads the passphrase hash, which it has no reason to compare', async () => {
    gated();

    const { promise } = run({ path: '/p/u/scope/slug' }, { id: 'owner1' });
    await promise;

    const sel = mocks.select.mock.calls[0][0] as string;
    expect(sel).not.toContain('passphraseHash');
    // ownerId and publicId must come from the SAME document, so the identity check and the
    // cookie key can never refer to different artifacts.
    expect(sel).toContain('ownerId');
    expect(sel).toContain('publicId');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findOne: vi.fn(),
    select: vi.fn(),
    lean: vi.fn(),
    stamp: vi.fn(() => Promise.resolve()),
  },
}));

const { lockout } = vi.hoisted(() => ({
  lockout: {
    checkLock: vi.fn(),
    recordFailure: vi.fn(),
    clear: vi.fn(() => Promise.resolve()),
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

// PublishedArtifact.findOne(...).select(...).lean() - capture the select string.
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
  gearStampRepository: { stamp: (...a: unknown[]) => mocks.stamp(...a) },
}));
vi.mock('@server/services/publish/parsePublishPath', () => ({
  segmentsFromViewerPathname: () => ['u', 'scope', 'slug'],
  parsePublishPath: () => ({ kind: 'bundle', tier: 'user', scopeId: 'scope', slug: 'slug', assetPath: null }),
}));
vi.mock('@server/services/publish/publishGateToken', () => ({ setGateProofCookie: () => true }));
vi.mock('@server/services/publish/passphraseLockout', () => lockout);
vi.mock('bcryptjs', () => ({ default: { compare: () => Promise.resolve(true) } }));

import handler from '../passphrase';

const run = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'u1' };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const gated = () =>
  mocks.lean.mockResolvedValue({ publicId: 'pub1', accessGate: { kind: 'passphrase', passphraseHash: 'h' } });

beforeEach(() => {
  vi.restoreAllMocks(); // reset bcrypt.compare spy history between tests
  Object.values(mocks).forEach(m => (m as { mockReset?: () => void }).mockReset?.());
  mocks.stamp.mockResolvedValue(undefined);
  lockout.checkLock.mockReset().mockResolvedValue({ locked: false, retryAfterMs: 0 });
  lockout.recordFailure.mockReset().mockResolvedValue({ locked: false, retryAfterMs: 0 });
  lockout.clear.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/publish/gate/passphrase - projection safety (regression: MongoDB path collision)', () => {
  it('never projects a parent path together with its child sub-path', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'hunter2secret' });
    await promise;

    expect(res._getStatusCode()).toBe(204);
    const sel = mocks.select.mock.calls[0][0] as string;
    // A parent field AND a dotted child of it in the same projection is the exact
    // shape MongoDB rejects at runtime ("Path collision at accessGate.passphraseHash").
    const fields = sel.split(/\s+/).filter(Boolean);
    const bare = new Set(fields.map(f => f.replace(/^[+-]/, '')));
    for (const f of bare) {
      const parent = f.split('.')[0];
      if (f !== parent) {
        expect(bare.has(parent)).toBe(false); // parent must NOT also be projected
      }
    }
  });

  it('rejects a wrong passphrase with 403', async () => {
    const bcrypt = (await import('bcryptjs')).default as { compare: () => Promise<boolean> };
    vi.spyOn(bcrypt, 'compare').mockResolvedValueOnce(false);
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'wrongpassword' });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});

describe('POST /api/publish/gate/passphrase - per-artifact lockout', () => {
  it('returns 423 with Retry-After when the gate is already locked, before checking bcrypt', async () => {
    const bcrypt = (await import('bcryptjs')).default as { compare: () => Promise<boolean> };
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    lockout.checkLock.mockResolvedValue({ locked: true, retryAfterMs: 90_000 });
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'anything123' });
    await promise;

    expect(res._getStatusCode()).toBe(423);
    expect(res.getHeader('Retry-After')).toBe(90);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('returns 423 when a wrong attempt trips the lock', async () => {
    const bcrypt = (await import('bcryptjs')).default as { compare: () => Promise<boolean> };
    vi.spyOn(bcrypt, 'compare').mockResolvedValueOnce(false);
    lockout.recordFailure.mockResolvedValue({ locked: true, retryAfterMs: 120_000 });
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'wrongpassword' });
    await promise;

    expect(res._getStatusCode()).toBe(423);
    expect(res.getHeader('Retry-After')).toBe(120);
    expect(lockout.recordFailure).toHaveBeenCalledWith('pub1');
  });

  it('records a failure but stays 403 while under the cap', async () => {
    const bcrypt = (await import('bcryptjs')).default as { compare: () => Promise<boolean> };
    vi.spyOn(bcrypt, 'compare').mockResolvedValueOnce(false);
    lockout.recordFailure.mockResolvedValue({ locked: false, retryAfterMs: 0 });
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'wrongpassword' });
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(lockout.recordFailure).toHaveBeenCalledWith('pub1');
  });

  it('clears the lock on a correct passphrase', async () => {
    gated();

    const { res, promise } = run({ path: '/p/u/scope/slug', passphrase: 'hunter2secret' });
    await promise;

    expect(res._getStatusCode()).toBe(204);
    expect(lockout.clear).toHaveBeenCalledWith('pub1');
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });
});

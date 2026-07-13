import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Contract tests for PATCH /api/publish/artifacts/[id] - specifically the domain
 * access-gate write path: entries are canonicalized to their registrable domain
 * (eTLD+1) before storage, and a bare public suffix (co.uk) is rejected.
 * No real database; the artifact doc is a plain mutable object with save()/toJSON().
 */

const { findOne } = vi.hoisted(() => ({ findOne: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> & ((req: { method?: string }, res: unknown) => unknown) = Object.assign(
      (req: { method?: string }, res: unknown) => h[req.method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        patch: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PATCH = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: (...a: unknown[]) => findOne(...a) },
}));

vi.mock('@server/services/publish', () => ({
  resolveVisibility: vi.fn(() => ({ ok: true })),
  invalidatePublishCdn: vi.fn(),
  toCacheTarget: vi.fn(() => ({})),
  validateEmbedOrigins: vi.fn(() => ({ ok: true, value: [] })),
}));

import handler from '../[id]';

const OWNER = 'owner-1';

/** A minimal artifact doc: an open-public artifact the owner is patching. */
function makeArtifact() {
  return {
    ownerId: OWNER,
    publicId: 'pub-1',
    tier: 'user',
    visibility: 'public' as string,
    accessGate: null as unknown,
    embedOrigins: undefined as string[] | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    toJSON() {
      return { publicId: this.publicId, visibility: this.visibility, accessGate: this.accessGate };
    },
  };
}

async function patchGate(allowedDomains: string[], artifact = makeArtifact()) {
  findOne.mockResolvedValue(artifact);
  const { req, res } = createMocks({ method: 'PATCH' });
  (req as unknown as { query: unknown }).query = { id: 'pub-1' };
  (req as unknown as { user?: unknown }).user = { id: OWNER };
  (req as unknown as { body: unknown }).body = { accessGate: { kind: 'domain', allowedDomains } };
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, artifact };
}

beforeEach(() => {
  findOne.mockReset();
});

describe('PATCH domain access gate - stored as entered, validated', () => {
  it('stores entries AS ENTERED (lowercased, de-duped) - never reduced to eTLD+1', async () => {
    const { res, artifact } = await patchGate(['mail.acme.com', 'acme.com', 'PARTNER.CO', 'acme.com']);
    expect(res._getStatusCode()).toBe(200);
    // mail.acme.com is kept distinct from acme.com; matching is exact-or-subdomain.
    expect(artifact.accessGate).toEqual({
      kind: 'domain',
      allowedDomains: ['mail.acme.com', 'acme.com', 'partner.co'],
    });
  });

  it('rejects a bare public suffix with a 400 (INVALID_DOMAIN)', async () => {
    const { res, artifact } = await patchGate(['acme.com', 'co.uk']);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'INVALID_DOMAIN' });
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('rejects a bare private/platform suffix (github.io) with a 400', async () => {
    const { res, artifact } = await patchGate(['github.io']);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'INVALID_DOMAIN' });
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('keeps a specific subdomain entry as-is (acme.onmicrosoft.com), not the shared parent', async () => {
    const { res, artifact } = await patchGate(['acme.onmicrosoft.com']);
    expect(res._getStatusCode()).toBe(200);
    expect(artifact.accessGate).toEqual({ kind: 'domain', allowedDomains: ['acme.onmicrosoft.com'] });
  });
});

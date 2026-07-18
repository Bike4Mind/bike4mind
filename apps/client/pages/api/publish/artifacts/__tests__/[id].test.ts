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

/** A public artifact carrying owner/moderation/storage internals. */
function makePublicArtifactRow() {
  return {
    publicId: 'pub-1',
    title: 'My Artifact',
    description: 'desc',
    visibility: 'public',
    commentPolicy: 'none',
    embedOrigins: undefined,
    publishedAt: new Date('2026-01-01').toISOString(),
    // Sensitive internals that must NOT reach a public viewer:
    ownerId: OWNER,
    lastPublishedBy: OWNER,
    storageKeyPrefix: 'artifacts/pub-1/',
    reportCount: 3,
    takedownReason: 'nsfw',
    deletedBy: null,
    moderationStatus: 'active',
    source: { kind: 'bundle' },
    tier: 'user',
    scopeId: 'scope-1',
  };
}

async function getArtifact(user: unknown, row = makePublicArtifactRow()) {
  findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(row) }) });
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { query: unknown }).query = { id: 'pub-1' };
  (req as unknown as { user?: unknown }).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('GET public artifact - response scoping', () => {
  it('returns only public display fields to a non-owner viewer', async () => {
    const res = await getArtifact({ id: 'someone-else', isAdmin: false });
    expect(res._getStatusCode()).toBe(200);
    const { artifact } = res._getJSONData();
    expect(artifact.title).toBe('My Artifact');
    expect(artifact.publicId).toBe('pub-1');
    for (const leaked of [
      'ownerId',
      'lastPublishedBy',
      'storageKeyPrefix',
      'reportCount',
      'takedownReason',
      'deletedBy',
      'moderationStatus',
      'source',
      'tier',
      'scopeId',
    ]) {
      expect(leaked in artifact).toBe(false);
    }
    expect(JSON.stringify(artifact)).not.toContain('artifacts/pub-1/');
  });

  it('returns only public display fields to an anonymous viewer', async () => {
    const res = await getArtifact(undefined);
    const { artifact } = res._getJSONData();
    expect('ownerId' in artifact).toBe(false);
    expect(artifact.title).toBe('My Artifact');
  });

  it('returns the full record to the owner (manage modal needs it)', async () => {
    const res = await getArtifact({ id: OWNER, isAdmin: false });
    const { artifact } = res._getJSONData();
    expect(artifact.ownerId).toBe(OWNER);
    expect(artifact.storageKeyPrefix).toBe('artifacts/pub-1/');
  });

  it('returns the full record to an admin', async () => {
    const res = await getArtifact({ id: 'admin-1', isAdmin: true });
    const { artifact } = res._getJSONData();
    expect(artifact.ownerId).toBe(OWNER);
  });

  it('does not leak DTO metadata for a GATED public artifact to a non-manager (404)', async () => {
    const gated = { ...makePublicArtifactRow(), accessGate: { kind: 'passphrase' } };
    const res = await getArtifact({ id: 'someone-else', isAdmin: false }, gated);
    expect(res._getStatusCode()).toBe(404);
  });

  it('still returns the full record for a GATED artifact to its owner', async () => {
    const gated = { ...makePublicArtifactRow(), accessGate: { kind: 'passphrase' } };
    const res = await getArtifact({ id: OWNER, isAdmin: false }, gated);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().artifact.ownerId).toBe(OWNER);
  });
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

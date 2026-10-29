import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import bcrypt from 'bcryptjs';

/**
 * Contract tests for PATCH /api/publish/artifacts/[id] - specifically the domain
 * access-gate write path: entries are canonicalized to their registrable domain
 * (eTLD+1) before storage, and a bare public suffix (co.uk) is rejected.
 * No real database; the artifact doc is a plain mutable object with save()/toJSON().
 */

const { findOne, deletePublishThumbnails, assertOutbound } = vi.hoisted(() => ({
  assertOutbound: vi.fn(async (_user: unknown, _req: unknown) => undefined as void),
  findOne: vi.fn(),
  deletePublishThumbnails: vi.fn(async (_publicIds: string[], _logger: unknown) => 0),
}));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: assertOutbound,
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({ deletePublishThumbnails }));

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
  // Faithful copy of the model's helper - the real one's behavior (including the legacy-scalar
  // fold-in) is pinned by PublishedArtifactModel.shareToken.test.ts. The gate-surface check
  // reads it rather than the scalar as of #3255 step 3.
  liveShareTokens: (artifact: { shareToken?: string; shareTokens?: { token?: string; revokedAt?: Date | null }[] }) => {
    const live = (artifact.shareTokens ?? []).filter(e => !!e?.token && !e.revokedAt);
    const legacy = artifact.shareToken;
    if (legacy && !live.some(e => e.token === legacy)) return [{ token: legacy, revokedAt: null }, ...live];
    return live;
  },
}));

vi.mock('@server/services/publish', () => ({
  resolveVisibility: vi.fn(() => ({ ok: true })),
  invalidatePublishCdn: vi.fn(),
  restrictDuplicatePublications: vi.fn(),
  toCacheTarget: vi.fn(() => ({})),
  validateEmbedOrigins: vi.fn(() => ({ ok: true, value: [] })),
}));

import handler from '../[id]';

const OWNER = 'owner-1';

/**
 * A minimal artifact doc: an open-public artifact the owner is patching.
 *
 * `toJSON` returns a COPY of accessGate, never the live reference. Real Mongoose toJSON
 * serializes to a fresh plain object, and the handler's last act is a defensive
 * `delete json.accessGate.passphraseHash` - against a shared reference that reaches back
 * into the doc under test and blanks the very field these tests assert on (making a
 * "never echoes the hash" assertion pass for the wrong reason).
 */
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
      const gate = this.accessGate as Record<string, unknown> | null;
      return { publicId: this.publicId, visibility: this.visibility, accessGate: gate ? { ...gate } : gate };
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
  assertOutbound.mockClear();
});

/** A public artifact carrying owner/moderation/storage internals. */
function makePublicArtifactRow() {
  return {
    publicId: 'pub-1',
    title: 'My Artifact',
    description: 'desc',
    tags: ['northwind', 'weekly'],
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

async function getArtifact(user: unknown, row = makePublicArtifactRow(), select = vi.fn()) {
  findOne.mockReturnValue({
    select: (fields: string) => (select(fields), { lean: () => Promise.resolve(row) }),
  });
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { query: unknown }).query = { id: 'pub-1' };
  (req as unknown as { user?: unknown }).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('GET public artifact - share-token capability', () => {
  it('projects the share token out of the query, since .lean() bypasses the toJSON strip', async () => {
    const select = vi.fn();
    await getArtifact({ id: 'someone-else', isAdmin: false }, makePublicArtifactRow(), select);
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith('-shareTokens.token -thumbnail');
  });
});

describe('owner-only thumbnails on the single-artifact route', () => {
  const thumbnail = { key: `publish-thumbnails/pub-1/${'a'.repeat(64)}.webp`, versionId: 'a'.repeat(64) };

  beforeEach(() => {
    deletePublishThumbnails.mockClear();
  });

  it('projects the stored thumbnail record out of the GET, so not even an admin read carries the key', async () => {
    const select = vi.fn();
    await getArtifact({ id: 'admin-1', isAdmin: true }, makePublicArtifactRow(), select);
    expect(String(select.mock.calls[0][0]).split(' ')).toContain('-thumbnail');
  });

  it('never echoes the thumbnail record in a PATCH response', async () => {
    const artifact = makeArtifact();
    const toJSON = artifact.toJSON.bind(artifact);
    artifact.toJSON = () => ({ ...toJSON(), thumbnail });
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = { title: 'Renamed' };
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.stringify(res._getJSONData())).not.toContain('publish-thumbnails');
    expect('thumbnail' in res._getJSONData().artifact).toBe(false);
  });

  async function remove(user: { id: string; isAdmin?: boolean }, artifact: Record<string, unknown> | null) {
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'DELETE' });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = user;
    (req as unknown as { logger: unknown }).logger = logger;
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return { res, logger };
  }

  it('deletes the thumbnail objects after the soft delete', async () => {
    const order: string[] = [];
    const softDelete = vi.fn(async () => void order.push('softDelete'));
    deletePublishThumbnails.mockImplementationOnce(async () => (order.push('thumbnails'), 1));
    const { res, logger } = await remove({ id: OWNER }, { ...makeArtifact(), softDelete });

    expect(res._getStatusCode()).toBe(200);
    expect(softDelete).toHaveBeenCalledWith(OWNER);
    expect(deletePublishThumbnails).toHaveBeenCalledWith(['pub-1'], logger);
    expect(order).toEqual(['softDelete', 'thumbnails']);
  });

  it('deletes nothing when the caller may not delete the artifact', async () => {
    const softDelete = vi.fn();
    const { res } = await remove({ id: 'someone-else' }, { ...makeArtifact(), softDelete });
    expect(res._getStatusCode()).toBe(403);
    expect(softDelete).not.toHaveBeenCalled();
    expect(deletePublishThumbnails).not.toHaveBeenCalled();
  });
});

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

  it('exposes tags to a non-owner, matching what the list route already projects', async () => {
    // Deliberate: tags are metadata in the same class as title and description, both already on
    // this path, and the list endpoint's non-`mine` branch has always projected them - so the two
    // reads disagreed. The OWNER-SCOPED property belongs to the vocabulary endpoint, not to tags on
    // an artifact document.
    const res = await getArtifact({ id: 'someone-else', isAdmin: false });
    expect(res._getJSONData().artifact.tags).toEqual(['northwind', 'weekly']);
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

describe('PATCH /api/publish/artifacts/[id] - discoverable (search-engine opt-in)', () => {
  async function patchBody(body: Record<string, unknown>, artifact = makeArtifact()) {
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = body;
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return { res, artifact };
  }

  it('sets discoverable when the owner opts in', async () => {
    const { res, artifact } = await patchBody({ discoverable: true });
    expect(res._getStatusCode()).toBe(200);
    expect((artifact as unknown as { discoverable?: boolean }).discoverable).toBe(true);
  });

  it('clears discoverable when the owner opts back out', async () => {
    const artifact = makeArtifact();
    (artifact as unknown as { discoverable?: boolean }).discoverable = true;
    const { res } = await patchBody({ discoverable: false }, artifact);
    expect(res._getStatusCode()).toBe(200);
    expect((artifact as unknown as { discoverable?: boolean }).discoverable).toBe(false);
  });

  it('leaves discoverable untouched when the field is absent from the patch', async () => {
    const artifact = makeArtifact();
    (artifact as unknown as { discoverable?: boolean }).discoverable = true;
    await patchBody({ title: 'Renamed' }, artifact);
    expect((artifact as unknown as { discoverable?: boolean }).discoverable).toBe(true);
  });

  it('rejects a non-boolean discoverable', async () => {
    const { res } = await patchBody({ discoverable: 'yes' });
    expect(res._getStatusCode()).toBe(400);
  });

  it('purges the CDN when discoverability changes - the robots header is cached', async () => {
    const { invalidatePublishCdn } = await import('@server/services/publish');
    vi.mocked(invalidatePublishCdn).mockClear();
    await patchBody({ discoverable: true });
    expect(invalidatePublishCdn).toHaveBeenCalled();
  });

  it('does NOT purge when discoverable is re-sent unchanged', async () => {
    const { invalidatePublishCdn } = await import('@server/services/publish');
    vi.mocked(invalidatePublishCdn).mockClear();
    const artifact = makeArtifact();
    (artifact as unknown as { discoverable?: boolean }).discoverable = true;
    await patchBody({ discoverable: true }, artifact);
    expect(invalidatePublishCdn).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/publish/artifacts/[id] - discoverable de-arms on leaving open-public', () => {
  async function patchBody(body: Record<string, unknown>, artifact = makeArtifact()) {
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = body;
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return { res, artifact };
  }

  /** A listed, open-public artifact. */
  function listedArtifact() {
    const a = makeArtifact();
    (a as unknown as { discoverable?: boolean }).discoverable = true;
    return a;
  }

  const isDiscoverable = (a: unknown) => (a as { discoverable?: boolean }).discoverable;

  it('clears discoverable when visibility drops to private', async () => {
    // Otherwise the flag survives inert and silently re-arms indexing whenever the
    // artifact is widened back to public - nobody chose that in context.
    const { res, artifact } = await patchBody({ visibility: 'private' }, listedArtifact());
    expect(res._getStatusCode()).toBe(200);
    expect(isDiscoverable(artifact)).toBe(false);
  });

  it('clears discoverable when a passphrase gate is added', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      listedArtifact()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(isDiscoverable(artifact)).toBe(false);
  });

  it('clears discoverable when a domain gate is added', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } },
      listedArtifact()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(isDiscoverable(artifact)).toBe(false);
  });

  it('rejects discoverable:true in the SAME patch that adds a gate', async () => {
    // Apply-order independence: the de-arm runs against the final open-public state.
    const { artifact } = await patchBody({
      discoverable: true,
      accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' },
    });
    expect(isDiscoverable(artifact)).toBe(false);
  });

  it('leaves discoverable alone while the artifact stays open-public', async () => {
    const { artifact } = await patchBody({ title: 'Renamed' }, listedArtifact());
    expect(isDiscoverable(artifact)).toBe(true);
  });

  it('purges the CDN on an implicit de-arm, not just an explicit toggle', async () => {
    // The robots header is cached bytes; a de-arm that skipped the purge would keep
    // serving an indexable copy for up to s-maxage.
    const { invalidatePublishCdn } = await import('@server/services/publish');
    vi.mocked(invalidatePublishCdn).mockClear();
    await patchBody({ visibility: 'private' }, listedArtifact());
    expect(invalidatePublishCdn).toHaveBeenCalled();
  });

  it('does not respond until the CDN purge has been sent', async () => {
    const { invalidatePublishCdn } = await import('@server/services/publish');
    let release!: () => void;
    vi.mocked(invalidatePublishCdn).mockImplementationOnce(() => new Promise<void>(r => (release = r)));
    findOne.mockResolvedValue(listedArtifact());
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = { visibility: 'private' };
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const done = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    await vi.waitFor(() => expect(invalidatePublishCdn).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(res._isEndCalled()).toBe(false);

    release();
    await done;
    expect(res._getStatusCode()).toBe(200);
  });

  it('carries a visibility change over to older duplicates of the same source, and only then', async () => {
    const { restrictDuplicatePublications } = await import('@server/services/publish');
    vi.mocked(restrictDuplicatePublications).mockClear();
    const { artifact } = await patchBody({ visibility: 'private' }, listedArtifact());
    expect(restrictDuplicatePublications).toHaveBeenCalledWith(artifact, expect.anything());
    vi.mocked(restrictDuplicatePublications).mockClear();
    await patchBody({ title: 'Renamed' }, listedArtifact());
    expect(restrictDuplicatePublications).not.toHaveBeenCalled();
  });

  it('does not re-list an artifact when a gate is later cleared', async () => {
    const a = makeArtifact();
    (a as unknown as { discoverable?: boolean }).discoverable = false;
    (a as unknown as { accessGate: unknown }).accessGate = { kind: 'passphrase' };
    const { artifact } = await patchBody({ accessGate: null }, a);
    expect(isDiscoverable(artifact)).toBe(false);
  });
});

/**
 * The gate-enforcement invariant (b4m-bob#275). The surface check used to key on
 * `visibility === 'public'` alone, which predates the share-token surface: checkShareGrant
 * runs the SAME checkAccessGate on top of `/a/<token>` possession at any visibility (#383),
 * and the passphrase-verify route resolves a `share` path by shareToken with no visibility
 * requirement. So the invariant is "does a surface ENFORCE this gate", and a share token is
 * such a surface. A private artifact with NO token still fails loud.
 */
describe('PATCH /api/publish/artifacts/[id] - a gate needs an ENFORCING surface, not public', () => {
  async function patchBody(body: Record<string, unknown>, artifact = makeArtifact()) {
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = body;
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return { res, artifact };
  }

  /** A PRIVATE artifact that has been shared by no-sign-in link (`/a/<token>`). */
  function tokenSharedPrivate() {
    const a = makeArtifact();
    a.visibility = 'private';
    (a as unknown as { shareToken?: string }).shareToken = 'TOKEN-abc123';
    return a;
  }

  /** A PRIVATE artifact whose only link lives in the shareTokens array (no legacy scalar). */
  function arrayOnlyShared(entryOver: Record<string, unknown> = {}) {
    const a = makeArtifact();
    a.visibility = 'private';
    (a as unknown as { shareTokens?: unknown[] }).shareTokens = [
      { _id: 'entry-arr-1', token: 'TOKEN-arr', createdAt: new Date(), revokedAt: null, ...entryOver },
    ];
    return a;
  }

  it('ACCEPTS a passphrase gate on a private artifact whose only live link is in the array', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      arrayOnlyShared()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(artifact.save).toHaveBeenCalled();
  });

  it('REJECTS a passphrase gate on a private artifact whose only array link is revoked', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      arrayOnlyShared({ revokedAt: new Date() })
    );
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('GATE_REQUIRES_ENFORCING_SURFACE');
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('ACCEPTS a passphrase gate on a private artifact that has a share token', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      tokenSharedPrivate()
    );
    expect(res._getStatusCode()).toBe(200);
    const gate = artifact.accessGate as { kind: string; passphraseHash: string };
    expect(gate.kind).toBe('passphrase');
    // Stored only as a bcrypt hash - never the raw passphrase.
    expect(gate.passphraseHash).toEqual(expect.any(String));
    expect(gate.passphraseHash).not.toBe('a-long-passphrase');
    expect(await bcrypt.compare('a-long-passphrase', gate.passphraseHash)).toBe(true);
    expect(artifact.save).toHaveBeenCalled();
  });

  it('never echoes the passphrase hash back in the response', async () => {
    const { res } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      tokenSharedPrivate()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.stringify(res._getJSONData())).not.toContain('passphraseHash');
  });

  it('ACCEPTS a domain gate on a token-shared private artifact (same enforcing surface)', async () => {
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } },
      tokenSharedPrivate()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(artifact.accessGate).toEqual({ kind: 'domain', allowedDomains: ['acme.com'] });
  });

  it('STILL REJECTS a gate on a private artifact with NO share token (nothing would enforce it)', async () => {
    const a = makeArtifact();
    a.visibility = 'private';
    const { res, artifact } = await patchBody(
      { accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } },
      a
    );
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('GATE_REQUIRES_ENFORCING_SURFACE');
    // Rejected BEFORE persisting - a 400 must not leave a half-applied gate behind.
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('STILL REJECTS a gate on an organization artifact with no share token', async () => {
    const a = makeArtifact();
    a.visibility = 'organization';
    const { res } = await patchBody({ accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } }, a);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('GATE_REQUIRES_ENFORCING_SURFACE');
  });

  it('rejects a short passphrase on a token-shared artifact (the 8-char floor still applies)', async () => {
    const { res } = await patchBody({ accessGate: { kind: 'passphrase', passphrase: 'short' } }, tokenSharedPrivate());
    expect(res._getStatusCode()).toBe(400);
  });

  it('keeps accepting a gate on a public artifact (the original path is unchanged)', async () => {
    const { res, artifact } = await patchBody({ accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } });
    expect(res._getStatusCode()).toBe(200);
    expect((artifact.accessGate as { kind: string }).kind).toBe('passphrase');
  });

  it('lets the owner CLEAR the gate on a token-shared private artifact', async () => {
    const a = tokenSharedPrivate();
    (a as unknown as { accessGate: unknown }).accessGate = { kind: 'passphrase', passphraseHash: 'x' };
    const { res, artifact } = await patchBody({ accessGate: null }, a);
    expect(res._getStatusCode()).toBe(200);
    expect(artifact.accessGate).toBeNull();
  });

  // The check reads STORED state, so it must not hold unrelated fields hostage on a
  // document that reached the bad state elsewhere (finalize preserves a gate while
  // setting a private visibility). A rename touches neither the gate nor visibility.
  it('lets a title-only PATCH through on an already private + gated + tokenless artifact', async () => {
    const a = makeArtifact();
    a.visibility = 'private';
    (a as unknown as { accessGate: unknown }).accessGate = { kind: 'passphrase', passphraseHash: 'x' };
    const { res, artifact } = await patchBody({ title: 'Renamed' }, a);
    expect(res._getStatusCode()).toBe(200);
    expect(artifact.save).toHaveBeenCalled();
  });

  it('still rejects a visibility-only downgrade that strands an existing gate', async () => {
    const a = makeArtifact();
    (a as unknown as { accessGate: unknown }).accessGate = { kind: 'passphrase', passphraseHash: 'x' };
    const { res, artifact } = await patchBody({ visibility: 'private' }, a);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('GATE_REQUIRES_ENFORCING_SURFACE');
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('does not purge the CDN for a private artifact gaining a gate - it was never open-public', async () => {
    const { invalidatePublishCdn } = await import('@server/services/publish');
    vi.mocked(invalidatePublishCdn).mockClear();
    await patchBody({ accessGate: { kind: 'passphrase', passphrase: 'a-long-passphrase' } }, tokenSharedPrivate());
    expect(invalidatePublishCdn).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/publish/artifacts/[id] - title/description purge the cached share page', () => {
  function titled(overrides: Record<string, unknown> = {}) {
    return Object.assign(makeArtifact(), { title: 'Old title', description: 'Old description' }, overrides);
  }

  async function patchBody(body: Record<string, unknown>, artifact = titled()) {
    const { invalidatePublishCdn } = await import('@server/services/publish');
    vi.mocked(invalidatePublishCdn).mockClear();
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = body;
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res._getStatusCode()).toBe(200);
    return vi.mocked(invalidatePublishCdn);
  }

  it('purges when the title of an open-public artifact changes', async () => {
    expect(await patchBody({ title: 'New title' })).toHaveBeenCalledTimes(1);
  });

  it('purges when the description of an open-public artifact changes', async () => {
    expect(await patchBody({ description: 'New description' })).toHaveBeenCalledTimes(1);
  });

  it('does NOT purge when the title and description are re-sent unchanged', async () => {
    expect(await patchBody({ title: 'Old title', description: 'Old description' })).not.toHaveBeenCalled();
  });

  it('purges when a non-empty description is cleared to empty', async () => {
    expect(await patchBody({ description: '' })).toHaveBeenCalledTimes(1);
  });

  it('purges the artifact it just saved, with the request logger', async () => {
    const { toCacheTarget } = await import('@server/services/publish');
    const target = { publicId: 'pub-1' };
    vi.mocked(toCacheTarget).mockReturnValueOnce(target as ReturnType<typeof toCacheTarget>);
    const artifact = titled();
    const invalidate = await patchBody({ title: 'New title' }, artifact);
    expect(toCacheTarget).toHaveBeenLastCalledWith(artifact);
    expect(invalidate.mock.calls[0][0]).toBe(target);
  });

  it('does NOT purge when an absent description is sent as empty', async () => {
    expect(await patchBody({ description: '' }, titled({ description: undefined }))).not.toHaveBeenCalled();
  });

  it('purges when the comment policy of an open-public artifact changes', async () => {
    expect(await patchBody({ commentPolicy: 'open' }, titled({ commentPolicy: 'none' }))).toHaveBeenCalledTimes(1);
  });

  it('purges when comments are switched on for an artifact with no stored policy', async () => {
    expect(await patchBody({ commentPolicy: 'open' })).toHaveBeenCalledTimes(1);
  });

  it('does NOT purge when the comment policy is re-sent unchanged, or absent is sent as none', async () => {
    expect(await patchBody({ commentPolicy: 'open' }, titled({ commentPolicy: 'open' }))).not.toHaveBeenCalled();
    expect(await patchBody({ commentPolicy: 'none' })).not.toHaveBeenCalled();
  });

  it('does NOT purge a comment-policy change on a gated public artifact - it is not cache-eligible', async () => {
    const gated = titled({ accessGate: { kind: 'passphrase', passphraseHash: 'x' } });
    expect(await patchBody({ commentPolicy: 'open' }, gated)).not.toHaveBeenCalled();
  });

  it('does NOT purge a tags-only change - tags are not rendered into the share page', async () => {
    expect(await patchBody({ tags: ['weekly'] })).not.toHaveBeenCalled();
  });

  it('does NOT purge a renamed private artifact - it was never cached', async () => {
    expect(await patchBody({ title: 'New title' }, titled({ visibility: 'private' }))).not.toHaveBeenCalled();
  });

  it('does NOT purge a renamed gated public artifact - it is not cache-eligible', async () => {
    const gated = titled({ accessGate: { kind: 'passphrase', passphraseHash: 'x' } });
    expect(await patchBody({ title: 'New title' }, gated)).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/publish/artifacts/[id] - outbound gate on widening exposure', () => {
  async function patch(
    body: Record<string, unknown>,
    artifact = Object.assign(makeArtifact(), { visibility: 'private' })
  ) {
    findOne.mockResolvedValue(artifact);
    const { req, res } = createMocks({ method: 'PATCH' });
    (req as unknown as { query: unknown }).query = { id: 'pub-1' };
    (req as unknown as { user?: unknown }).user = { id: OWNER };
    (req as unknown as { body: unknown }).body = body;
    (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return { res, artifact };
  }

  it('rejects making a page public when the gate refuses, without saving', async () => {
    const { ForbiddenError } = await import('@bike4mind/server-utils/utils/errors');
    assertOutbound.mockRejectedValueOnce(new ForbiddenError('restricted'));
    const artifact = Object.assign(makeArtifact(), { visibility: 'private' });
    await expect(patch({ visibility: 'public' }, artifact)).rejects.toBeInstanceOf(ForbiddenError);
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('does not consult the gate for a title-only edit', async () => {
    const { res } = await patch({ title: 'Renamed' });
    expect(res._getStatusCode()).toBe(200);
    expect(assertOutbound).not.toHaveBeenCalled();
  });

  const passphraseGated = () =>
    Object.assign(makeArtifact(), { accessGate: { kind: 'passphrase', passphraseHash: 'x' } as unknown });
  const domainGated = (allowedDomains: string[]) =>
    Object.assign(makeArtifact(), { accessGate: { kind: 'domain', allowedDomains } as unknown });

  it.each([
    [
      'making a private page public',
      { visibility: 'public' },
      () => Object.assign(makeArtifact(), { visibility: 'private' }),
    ],
    ['clearing the gate on a public page', { accessGate: null }, passphraseGated],
    ['turning on search indexing', { discoverable: true }, makeArtifact],
    [
      'adding an allowed domain',
      { accessGate: { kind: 'domain', allowedDomains: ['acme.com', 'other.com'] } },
      () => domainGated(['acme.com']),
    ],
    [
      'swapping a passphrase for a domain gate',
      { accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } },
      passphraseGated,
    ],
    [
      'swapping a domain gate for a passphrase',
      { accessGate: { kind: 'passphrase', passphrase: 'long-enough-pass' } },
      () => domainGated(['acme.com']),
    ],
    [
      'clearing the gate on a private page reachable by share link',
      { accessGate: null },
      () =>
        Object.assign(passphraseGated(), {
          visibility: 'private',
          shareTokens: [{ token: 'tok', revokedAt: null }],
        }),
    ],
  ])('rejects %s when the gate refuses, without saving', async (_label, body, build) => {
    const { ForbiddenError } = await import('@bike4mind/server-utils/utils/errors');
    assertOutbound.mockRejectedValueOnce(new ForbiddenError('restricted'));
    const artifact = build();
    await expect(patch(body, artifact)).rejects.toBeInstanceOf(ForbiddenError);
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it('rejects adding an embed origin when the gate refuses, without saving', async () => {
    const { ForbiddenError } = await import('@bike4mind/server-utils/utils/errors');
    const { validateEmbedOrigins } = await import('@server/services/publish');
    vi.mocked(validateEmbedOrigins).mockReturnValueOnce({ ok: true, value: ['https://example.com'] });
    assertOutbound.mockRejectedValueOnce(new ForbiddenError('restricted'));
    const artifact = makeArtifact();
    await expect(patch({ embedOrigins: ['https://example.com'] }, artifact)).rejects.toBeInstanceOf(ForbiddenError);
    expect(artifact.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      'adding a passphrase to an open public page',
      { accessGate: { kind: 'passphrase', passphrase: 'long-enough-pass' } },
      makeArtifact,
    ],
    ['making a public page private', { visibility: 'private' }, makeArtifact],
    [
      'rotating the passphrase',
      { accessGate: { kind: 'passphrase', passphrase: 'another-long-pass' } },
      passphraseGated,
    ],
    [
      'removing an allowed domain',
      { accessGate: { kind: 'domain', allowedDomains: ['acme.com'] } },
      () => domainGated(['acme.com', 'other.com']),
    ],
    [
      'turning off search indexing',
      { discoverable: false },
      () => Object.assign(makeArtifact(), { discoverable: true }),
    ],
  ])('does not consult the gate for %s', async (_label, body, build) => {
    const { res } = await patch(body, build());
    expect(res._getStatusCode()).toBe(200);
    expect(assertOutbound).not.toHaveBeenCalled();
  });
});

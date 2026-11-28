import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  aggregate: vi.fn(),
  projectFind: vi.fn(),
  assertOutbound: vi.fn(async (_user: unknown, _req: unknown) => undefined as void),
  loadLiveOwner: vi.fn(async (_ownerId: string) => ({ name: 'Owner' }) as { name: string } | null),
  excludeNonLiveOwners: vi.fn(async () => null as unknown),
  resolveVisibility: vi.fn((_tier: string, _v: string) => ({ ok: true }) as Record<string, unknown>),
  validateEmbedOrigins: vi.fn(
    (_o: string[], _opts: unknown) => ({ ok: true, value: [] as string[] }) as Record<string, unknown>
  ),
  invalidatePublishCdn: vi.fn(async () => undefined),
  restrictDuplicatePublications: vi.fn(async () => undefined),
  deletePublishThumbnails: vi.fn(async () => 0),
  assertPublicationPublicLink: vi.fn(async () => undefined),
  refund: vi.fn(async () => undefined),
  consume: vi.fn(),
}));
mocks.consume.mockImplementation(async () => ({ refund: mocks.refund }));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ assertOutboundActionAllowed: mocks.assertOutbound }));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  deletePublishThumbnails: mocks.deletePublishThumbnails,
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: mocks.findOne, aggregate: mocks.aggregate },
  Project: { find: mocks.projectFind },
  liveShareTokens: (artifact: { shareTokens?: { token?: string }[] }) =>
    (artifact.shareTokens ?? []).filter(t => t.token),
}));
vi.mock('./publishRateLimit', () => ({ consumePublishAction: mocks.consume }));
vi.mock('./organizationPolicy', () => ({ assertPublicationPublicLink: mocks.assertPublicationPublicLink }));
vi.mock('./thumbnailUrl', () => ({ signOwnerThumbnailUrl: vi.fn(async () => 'https://thumb.test/x') }));
vi.mock('@server/services/publish', async () => {
  const filter = await import('./buildListFilter');
  const query = await import('./buildListQuery');
  return {
    buildListVisibilityFilter: filter.buildListVisibilityFilter,
    buildListQuery: query.buildListQuery,
    excludeNonLiveOwners: mocks.excludeNonLiveOwners,
    loadLiveOwner: mocks.loadLiveOwner,
    resolveVisibility: mocks.resolveVisibility,
    validateEmbedOrigins: mocks.validateEmbedOrigins,
    invalidatePublishCdn: mocks.invalidatePublishCdn,
    restrictDuplicatePublications: mocks.restrictDuplicatePublications,
    toCacheTarget: vi.fn(() => ({})),
  };
});

import {
  deletePublishedPage,
  getPublishedPage,
  isManagePublishedPageError,
  listPublishedPages,
  toLegacyErrorBody,
  updatePublishedPage,
} from './managePublishedPages';

const OWNER = { id: 'owner-1' };
const OTHER = { id: 'other-1' };
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

function makeArtifact(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: 'owner-1',
    publicId: 'pub-1',
    tier: 'user',
    title: 'Old',
    visibility: 'public' as string,
    accessGate: null as unknown,
    embedOrigins: undefined as string[] | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(undefined),
    toJSON() {
      return {
        publicId: this.publicId,
        title: this.title,
        thumbnail: { key: 'k' },
        accessGate: this.accessGate && { ...(this.accessGate as object) },
      };
    },
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(isManagePublishedPageError(error)).toBe(true);
    return error as { statusCode: number; message: string; additionalInfo: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadLiveOwner.mockResolvedValue({ name: 'Owner' });
  mocks.resolveVisibility.mockReturnValue({ ok: true });
  mocks.validateEmbedOrigins.mockReturnValue({ ok: true, value: [] });
  mocks.projectFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

describe('listPublishedPages', () => {
  const row = (overrides: Record<string, unknown>) => ({ publicId: 'p', title: 'T', ownerId: 'owner-1', ...overrides });

  it('returns the page, total and paging data, clamping limit and skip', async () => {
    mocks.aggregate.mockResolvedValueOnce([{ rows: [row({})], total: [{ n: 5 }] }]);
    const result = await listPublishedPages({ user: OWNER, mine: true, limit: 0, skip: -3 });
    expect(result).toMatchObject({ total: 5, limit: 1, skip: 0, nextSkip: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.facets).toEqual({ kind: {}, visibility: {}, gate: {}, comments: 0, tag: {} });
  });

  it('has no next page when the page reaches the total', async () => {
    mocks.aggregate.mockResolvedValueOnce([{ rows: [row({})], total: [{ n: 1 }] }]);
    const result = await listPublishedPages({ user: OWNER, mine: true });
    expect(result).toMatchObject({ limit: 200, nextSkip: null });
  });

  it('trims other owners rows to display fields and leaves admins untouched', async () => {
    const rows = [row({ ownerId: 'someone', scopeId: 's', viewCount: 2 })];
    mocks.aggregate.mockResolvedValueOnce([{ rows, total: [{ n: 1 }] }]);
    const member = await listPublishedPages({ user: OWNER });
    expect(member.items[0]).not.toHaveProperty('ownerId');
    expect(member.items[0]).toMatchObject({ publicId: 'p', viewCount: 2 });

    mocks.aggregate.mockResolvedValueOnce([{ rows, total: [{ n: 1 }] }]);
    const admin = await listPublishedPages({ user: { id: 'admin', isAdmin: true } });
    expect(admin.items[0]).toHaveProperty('ownerId', 'someone');
  });

  it('signs a thumbnail only for the callers own rows on mine and computes facets', async () => {
    mocks.aggregate
      .mockResolvedValueOnce([{ rows: [{ ...row({}), thumbnailKey: 'k' }], total: [{ n: 1 }] }])
      .mockResolvedValueOnce([{ byKind: [{ _id: 'bundle', n: 2 }], withComments: [{ n: 4 }], byTag: [] }]);
    const result = await listPublishedPages({ user: OWNER, mine: true, facets: true });
    expect(result.items[0]).toHaveProperty('thumbnailUrl', 'https://thumb.test/x');
    expect(result.facets).toMatchObject({ kind: { bundle: 2 }, comments: 4 });
  });
});

describe('getPublishedPage', () => {
  const lean = (doc: unknown) => ({ select: () => ({ lean: async () => doc }) });
  const publicRow = () => ({ publicId: 'pub-1', ownerId: 'owner-1', visibility: 'public', title: 'T' });

  it('returns the management document with secrets stripped for the owner', async () => {
    mocks.findOne.mockReturnValue(
      lean({ ...publicRow(), renderedBody: 'x', accessGate: { kind: 'passphrase', passphraseHash: 'h' } })
    );
    const { artifact, isManager } = await getPublishedPage({ user: OWNER, publicId: 'pub-1' });
    expect(isManager).toBe(true);
    expect(artifact).not.toHaveProperty('renderedBody');
    expect(artifact.accessGate).toEqual({ kind: 'passphrase' });
  });

  it('returns the record to an anonymous viewer of an ungated public page', async () => {
    mocks.findOne.mockReturnValue(lean(publicRow()));
    expect(await getPublishedPage({ publicId: 'pub-1' })).toMatchObject({ isManager: false });
  });

  it('throws not_found (404) for a missing page', async () => {
    mocks.findOne.mockReturnValue(lean(null));
    const error = await errorOf(getPublishedPage({ user: OWNER, publicId: 'x' }));
    expect(error).toMatchObject({ statusCode: 404, message: 'Artifact not found' });
    expect(error.additionalInfo.errorCode).toBe('not_found');
  });

  it('throws authentication_required (401) for an anonymous viewer of a private page', async () => {
    mocks.findOne.mockReturnValue(lean({ ...publicRow(), visibility: 'private' }));
    const error = await errorOf(getPublishedPage({ publicId: 'pub-1' }));
    expect(error.statusCode).toBe(401);
    expect(error.additionalInfo.errorCode).toBe('authentication_required');
  });

  it('throws forbidden (403) for a non-manager of a private page', async () => {
    mocks.findOne.mockReturnValue(lean({ ...publicRow(), visibility: 'private' }));
    const error = await errorOf(getPublishedPage({ user: OTHER, publicId: 'pub-1' }));
    expect(error.statusCode).toBe(403);
    expect(error.additionalInfo.errorCode).toBe('forbidden');
  });

  it('hides a gated public page and a page of a non-live owner from non-managers', async () => {
    mocks.findOne.mockReturnValue(lean({ ...publicRow(), accessGate: { kind: 'passphrase' } }));
    expect((await errorOf(getPublishedPage({ user: OTHER, publicId: 'pub-1' }))).statusCode).toBe(404);

    mocks.findOne.mockReturnValue(lean(publicRow()));
    mocks.loadLiveOwner.mockResolvedValue(null);
    expect((await errorOf(getPublishedPage({ user: OTHER, publicId: 'pub-1' }))).statusCode).toBe(404);
  });
});

describe('updatePublishedPage', () => {
  const run = (patch: Parameters<typeof updatePublishedPage>[0]['patch'], artifact = makeArtifact(), user = OWNER) => {
    mocks.findOne.mockResolvedValue(artifact);
    return updatePublishedPage({ user, logger, publicId: 'pub-1', patch });
  };

  it('applies the patch, saves and returns the document without the thumbnail', async () => {
    const artifact = makeArtifact();
    const json = await run({ title: 'New', tags: ['B', 'b'] }, artifact);
    expect(artifact.title).toBe('New');
    expect(artifact.save).toHaveBeenCalled();
    expect(json).not.toHaveProperty('thumbnail');
    expect(mocks.invalidatePublishCdn).toHaveBeenCalled();
  });

  it('hashes a passphrase and never echoes the hash', async () => {
    const artifact = makeArtifact();
    const json = await run({ accessGate: { kind: 'passphrase', passphrase: 'correct horse' } }, artifact);
    expect((artifact.accessGate as { passphraseHash: string }).passphraseHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(json)).not.toContain('$2');
    expect(mocks.assertOutbound).not.toHaveBeenCalled();
  });

  it('checks the outbound gate and the public-link policy when exposure widens', async () => {
    await run({ visibility: 'public' }, makeArtifact({ visibility: 'private' }));
    expect(mocks.assertPublicationPublicLink).toHaveBeenCalled();
    expect(mocks.assertOutbound).toHaveBeenCalledTimes(1);
    expect(mocks.restrictDuplicatePublications).toHaveBeenCalled();
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('does not charge a non-widening edit', async () => {
    await run({ title: 'x' });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('throws not_found (404)', async () => {
    mocks.findOne.mockResolvedValue(null);
    const error = await errorOf(updatePublishedPage({ user: OWNER, logger, publicId: 'x', patch: {} }));
    expect(error.statusCode).toBe(404);
    expect(error.additionalInfo.errorCode).toBe('not_found');
  });

  it('throws forbidden (403) for a non-owner and lets an admin through', async () => {
    const error = await errorOf(run({ title: 'x' }, makeArtifact(), OTHER));
    expect(error).toMatchObject({ statusCode: 403, message: 'Not authorized to update this artifact' });
    expect(error.additionalInfo.errorCode).toBe('forbidden');
    await expect(run({ title: 'x' }, makeArtifact(), { id: 'a', isAdmin: true })).resolves.toBeDefined();
  });

  it('throws invalid_override (400) with the legacy code', async () => {
    mocks.resolveVisibility.mockReturnValue({ ok: false, error: 'nope', code: 'invalid_override' });
    const error = await errorOf(run({ visibility: 'org' }));
    expect(error.statusCode).toBe(400);
    expect(error.additionalInfo.errorCode).toBe('invalid_override');
    expect(toLegacyErrorBody(error as never)).toEqual({ error: 'nope', code: 'invalid_override' });
  });

  it('throws invalid_domain (400) for a bare public suffix', async () => {
    const error = await errorOf(run({ accessGate: { kind: 'domain', allowedDomains: ['co.uk'] } }));
    expect(error.statusCode).toBe(400);
    expect(error.additionalInfo.errorCode).toBe('invalid_domain');
    expect(toLegacyErrorBody(error as never).code).toBe('INVALID_DOMAIN');
  });

  it('throws gate_requires_enforcing_surface (400) for a gate on a private page without a live link', async () => {
    const error = await errorOf(
      run({ accessGate: { kind: 'passphrase', passphrase: 'correct horse' } }, makeArtifact({ visibility: 'private' }))
    );
    expect(error.statusCode).toBe(400);
    expect(error.additionalInfo.errorCode).toBe('gate_requires_enforcing_surface');
    expect(toLegacyErrorBody(error as never).code).toBe('GATE_REQUIRES_ENFORCING_SURFACE');
  });

  it('maps a rejected embed allowlist to its lowercased errorCode and legacy code', async () => {
    mocks.validateEmbedOrigins.mockReturnValue({ ok: false, error: 'bad origin', code: 'EMBED_ORIGIN_INVALID' });
    const error = await errorOf(run({ embedOrigins: ['http://x'] }));
    expect(error.statusCode).toBe(400);
    expect(error.additionalInfo.errorCode).toBe('embed_origin_invalid');
    expect(toLegacyErrorBody(error as never)).toEqual({ error: 'bad origin', code: 'EMBED_ORIGIN_INVALID' });
  });

  it('does not classify foreign errors as its own', async () => {
    const trust = Object.assign(new Error('x'), {
      statusCode: 403,
      additionalInfo: { errorCode: 'account_trust_required' },
    });
    expect(isManagePublishedPageError(trust)).toBe(false);
    mocks.assertOutbound.mockRejectedValueOnce(trust);
    await expect(run({ discoverable: true }, makeArtifact())).rejects.toBe(trust);
  });
});

describe('deletePublishedPage', () => {
  it('soft-deletes, purges the CDN for a public page and removes thumbnails', async () => {
    const artifact = makeArtifact();
    mocks.findOne.mockResolvedValue(artifact);
    await deletePublishedPage({ user: OWNER, logger, publicId: 'pub-1' });
    expect(artifact.softDelete).toHaveBeenCalledWith('owner-1');
    expect(mocks.invalidatePublishCdn).toHaveBeenCalled();
    expect(mocks.deletePublishThumbnails).toHaveBeenCalledWith(['pub-1'], logger);
  });

  it('throws not_found (404) and forbidden (403)', async () => {
    mocks.findOne.mockResolvedValue(null);
    const missing = await errorOf(deletePublishedPage({ user: OWNER, logger, publicId: 'x' }));
    expect(missing.statusCode).toBe(404);
    mocks.findOne.mockResolvedValue(makeArtifact());
    const denied = await errorOf(deletePublishedPage({ user: OTHER, logger, publicId: 'pub-1' }));
    expect(denied).toMatchObject({ statusCode: 403, message: 'Not authorized to delete this artifact' });
    expect(denied.additionalInfo.errorCode).toBe('forbidden');
  });
});

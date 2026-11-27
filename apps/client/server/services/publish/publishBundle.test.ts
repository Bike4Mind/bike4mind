import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PUBLISH_LIMITS } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  scope: vi.fn(),
  quota: vi.fn(),
  refund: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({
    download: m.download,
    upload: m.upload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(m.findOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(m.findOneAndUpdate(...a)),
  },
  liveShareTokens: () => [],
}));
vi.mock('@server/services/publish/organizationPolicy', () => ({ assertPublicationPublicLink: async () => undefined }));
vi.mock('@server/services/publish/checkPublishQuota', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, checkPublishQuota: (...a: unknown[]) => m.quota(...a) };
});
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkScopePermission: (...a: unknown[]) => m.scope(...a),
    checkPublishQuota: (...a: unknown[]) => m.quota(...a),
    consumePublishAction: async () => ({ refund: m.refund }),
    mintDraftUploadUrl: async ({ key }: { key: string }) => ({ url: `https://upload.test/${key}`, method: 'PUT' }),
    buildPublishS3KeyPrefix: () => 'user/owner1/art/',
    buildPublishUrlPath: () => '/p/u/owner1/art',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
  };
});

import { createBundleUpload, finalizeBundle, toLegacyPublishErrorResponse } from './publishBundle';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const user = { id: 'owner1', isAdmin: false, organizationId: null };
const html = { path: 'index.html', size: 10, mimeType: 'text/html' };
const baseUpload = {
  user,
  logger,
  tier: 'user' as const,
  scopeId: 'owner1',
  slug: 'art',
  title: 'T',
  files: [html],
};

const codeOf = (err: unknown) => (err as { additionalInfo?: { errorCode?: string } }).additionalInfo?.errorCode;
const failure = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error & { statusCode: number }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.findOne.mockReset().mockReturnValue(null);
  m.findOneAndUpdate.mockReset().mockReturnValue({ visibility: 'private', publicId: 'pub1' });
  m.download.mockReset();
  m.upload.mockReset().mockResolvedValue(undefined);
  m.scope.mockReset().mockResolvedValue({ ok: true });
  m.quota.mockReset().mockResolvedValue({ ok: true });
});

describe('createBundleUpload', () => {
  it('writes the draft manifest and returns the draft id with one target per file', async () => {
    const out = await createBundleUpload(baseUpload);
    expect(out.uploadUrls.map(u => u.path)).toEqual(['index.html']);
    expect(out.uploadUrls[0].url).toContain(`drafts/${out.draftId}/index.html`);
    const [body, key] = m.upload.mock.calls[0] as [Buffer, string];
    expect(key).toBe(`drafts/${out.draftId}/_manifest.json`);
    expect(JSON.parse(body.toString())).toMatchObject({ createdBy: 'owner1', slug: 'art', visibility: 'private' });
  });

  it.each([
    ['too_many_files', { files: Array.from({ length: PUBLISH_LIMITS.maxFiles + 1 }, () => html) }],
    ['invalid_file_path', { files: [html, { path: '../x', size: 1, mimeType: 'text/html' }] }],
    ['file_too_large', { files: [{ ...html, size: PUBLISH_LIMITS.maxFileBytes + 1 }] }],
    ['disallowed_mime_type', { files: [html, { path: 'a.exe', size: 1, mimeType: 'application/x-msdownload' }] }],
    ['missing_index_html', { files: [{ ...html, path: 'home.html' }] }],
  ])('rejects with %s (400)', async (errorCode, over) => {
    const err = await failure(createBundleUpload({ ...baseUpload, ...over }));
    expect(err?.statusCode).toBe(400);
    expect(codeOf(err)).toBe(errorCode);
    expect(toLegacyPublishErrorResponse(err)?.body).toEqual({ error: err!.message });
  });

  it('rejects an oversized bundle with bundle_too_large', async () => {
    const per = PUBLISH_LIMITS.maxFileBytes;
    const n = Math.ceil(PUBLISH_LIMITS.maxBundleBytes / per) + 1;
    const files = [
      html,
      ...Array.from({ length: n }, (_, i) => ({ path: `f${i}.png`, size: per, mimeType: 'image/png' })),
    ];
    const err = await failure(createBundleUpload({ ...baseUpload, files }));
    expect(['bundle_too_large', 'too_many_files']).toContain(codeOf(err));
  });

  it('maps a scope denial to scope_not_permitted with its status', async () => {
    m.scope.mockResolvedValue({ ok: false, status: 403, error: 'nope' });
    const err = await failure(createBundleUpload(baseUpload));
    expect(err?.statusCode).toBe(403);
    expect(codeOf(err)).toBe('scope_not_permitted');
  });

  it('rejects a bad visibility override with invalid_override', async () => {
    const err = await failure(createBundleUpload({ ...baseUpload, visibility: 'project' }));
    expect(err?.statusCode).toBe(400);
    expect(codeOf(err)).toBe('invalid_override');
    expect(toLegacyPublishErrorResponse(err)?.body).toMatchObject({ code: 'invalid_override' });
  });

  it('rejects a republish by a non-owner with slug_owned_by_other (403)', async () => {
    m.findOne.mockReturnValue({ ownerId: 'someone-else' });
    const err = await failure(createBundleUpload(baseUpload));
    expect(err?.statusCode).toBe(403);
    expect(codeOf(err)).toBe('slug_owned_by_other');
  });

  it('carries the quota code and details', async () => {
    const details = { scope: 'user', limit: 1, current: 1, attempted: 1 };
    m.quota.mockResolvedValue({ ok: false, status: 413, code: 'quota_bytes_exceeded', error: 'full', details });
    const err = await failure(createBundleUpload(baseUpload));
    expect(err?.statusCode).toBe(413);
    expect(toLegacyPublishErrorResponse(err)?.body).toEqual({
      error: 'full',
      code: 'quota_bytes_exceeded',
      details,
    });
  });

  it('refunds the publish action when the draft cannot be written', async () => {
    m.upload.mockRejectedValue(new Error('s3 down'));
    await expect(createBundleUpload(baseUpload)).rejects.toThrow('s3 down');
    expect(m.refund).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeBundle', () => {
  const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
  const page = '<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>';
  const manifest = (over: Record<string, unknown> = {}) => ({
    draftId: DRAFT_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'owner1',
    tier: 'user',
    scopeId: 'owner1',
    slug: 'art',
    title: 'T',
    visibility: 'private',
    source: { kind: 'bundle' },
    files: [{ path: 'index.html', size: 1, mimeType: 'text/html' }],
    ...over,
  });
  const setDraft = (man: Record<string, unknown>, index = page) =>
    m.download.mockImplementation((key: string) =>
      key.endsWith('_manifest.json')
        ? Promise.resolve(Buffer.from(JSON.stringify(man)))
        : Promise.resolve(Buffer.from(index))
    );
  const run = (over: Partial<Parameters<typeof finalizeBundle>[0]> = {}) =>
    finalizeBundle({ user, logger, draftId: DRAFT_ID, ...over });

  it('promotes the draft and returns the page identity', async () => {
    setDraft(manifest());
    const out = await run();
    expect(out).toMatchObject({
      publicId: 'pub1',
      url: '/p/u/owner1/art',
      tier: 'user',
      scopeId: 'owner1',
      slug: 'art',
      visibility: 'private',
    });
    expect(m.upload.mock.calls.some(c => String(c[1]) === 'user/owner1/art/index.html')).toBe(true);
    expect(m.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed draft id (400)', async () => {
    const err = await failure(run({ draftId: 'nope' }));
    expect(err?.statusCode).toBe(400);
    expect(codeOf(err)).toBe('invalid_draft_id');
  });

  it('rejects a missing draft (404)', async () => {
    m.download.mockRejectedValue(new Error('NoSuchKey'));
    const err = await failure(run());
    expect(err?.statusCode).toBe(404);
    expect(codeOf(err)).toBe('draft_not_found');
  });

  it('rejects a draft created by someone else (403)', async () => {
    setDraft(manifest({ createdBy: 'other' }));
    const err = await failure(run());
    expect(err?.statusCode).toBe(403);
    expect(codeOf(err)).toBe('draft_not_owned');
  });

  it('rejects a visibility the scope no longer allows (400)', async () => {
    setDraft(manifest({ visibility: 'project' }));
    const err = await failure(run());
    expect(err?.statusCode).toBe(400);
    expect(codeOf(err)).toBe('draft_visibility_invalid');
  });

  it('maps a scope denial to scope_not_permitted', async () => {
    setDraft(manifest());
    m.scope.mockResolvedValue({ ok: false, status: 404, error: 'gone' });
    const err = await failure(run());
    expect(err?.statusCode).toBe(404);
    expect(codeOf(err)).toBe('scope_not_permitted');
  });

  it('reports a missing uploaded file as validation_failed (422) with violations', async () => {
    m.download.mockImplementation((key: string) =>
      key.endsWith('_manifest.json')
        ? Promise.resolve(Buffer.from(JSON.stringify(manifest())))
        : Promise.reject(new Error('NoSuchKey'))
    );
    const err = await failure(run());
    expect(err?.statusCode).toBe(422);
    expect(codeOf(err)).toBe('validation_failed');
    expect(toLegacyPublishErrorResponse(err)?.body).toMatchObject({
      error: 'Validation failed',
      violations: [{ type: 'invalid_asset_url', file: 'index.html' }],
    });
  });

  it('rejects a republish by a non-owner with slug_owned_by_other (403)', async () => {
    setDraft(manifest());
    m.findOne.mockReturnValue({ publicId: 'p', ownerId: 'someone-else', publishedAt: new Date(), size: {} });
    const err = await failure(run());
    expect(err?.statusCode).toBe(403);
    expect(codeOf(err)).toBe('slug_owned_by_other');
  });

  it('answers 409 when another request took the slug', async () => {
    setDraft(manifest());
    m.findOneAndUpdate.mockReturnValue(null);
    const err = await failure(run());
    expect(err?.statusCode).toBe(409);
    expect(toLegacyPublishErrorResponse(err)).toEqual({
      status: 409,
      body: { error: 'This slug was published by another request', code: 'slug_owned_by_other' },
    });
  });

  it('rejects an invalid embed allowlist with its embed code (400)', async () => {
    setDraft(manifest({ visibility: 'private', embedOrigins: ['https://x.test'] }));
    const err = await failure(run());
    expect(err?.statusCode).toBe(400);
    expect(codeOf(err)).toBe('EMBED_REQUIRES_OPEN_PUBLIC');
  });

  it('does not map foreign errors', () => {
    expect(toLegacyPublishErrorResponse(new Error('boom'))).toBeNull();
  });
});

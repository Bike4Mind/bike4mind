import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The publish-time tag write, driven through BOTH real handlers.
 *
 * This closes a real coverage gap: tags are threaded through `upload-url` -> draft -> `finalize` so
 * a CLI can tag in one call, and that path had no test at all - the normalization helper, the PATCH
 * and the UI were covered, and the one path the feature exists for was not.
 *
 * The guard under test is the NORMALIZED length, not `tags`. `[]` is truthy, so a client that always
 * sends the field - the normal way to write one - cleared an artifact's tags on every re-publish;
 * and a raw-length check has the same hole one step in, since `['  ']` passes it and then normalizes
 * to `[]`. Clearing belongs to the PATCH path, which has unambiguous full-replace semantics; a
 * publish can only ADD. Same shape and reasoning as the neighbouring `embedOrigins` guard, and the
 * mock scaffolding here is lifted from finalize.embed.test.ts for that reason.
 *
 * An earlier version of this file asserted against a local copy of the guard that "mirrors both
 * write sites" and imported neither handler, so it would have stayed green through a revert at
 * either one. Both sites are exercised for real below.
 */

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockDownload: vi.fn(),
  mockUpload: vi.fn(() => Promise.resolve()),
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

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(mockFindOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(mockFindOneAndUpdate(...a)),
  },
}));

// `@bike4mind/common` is deliberately NOT mocked: normalizePublishTags is the thing whose output
// the guard reads, so a stub would test the mock. Only the heavy publish-service surface is stubbed,
// far enough for each handler to reach its write.
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    validateBundle: () => ({ valid: true, violations: [] }),
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility?: string) => ({ ok: true, visibility: visibility ?? 'private' }),
    buildPublishS3KeyPrefix: () => 'user/owner1/s/',
    buildPublishUrlPath: () => '/p/u/owner1/s',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
    mintDraftUploadUrl: () => Promise.resolve('https://example.invalid/put'),
  };
});

import finalizeHandler from '../finalize';
import uploadUrlHandler from '../upload-url';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const INDEX_HTML = '<html><head></head><body><h1>Hi</h1></body></html>';

const post = (handler: unknown, body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: 'owner1', isAdmin: false, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (handler as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

// ── finalize: draft manifest -> the artifact's $set ──

const manifest = (over: Record<string, unknown> = {}) => ({
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 's',
  title: 'My Artifact',
  visibility: 'private',
  source: { kind: 'bundle' },
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
  ...over,
});

/** Run finalize against a draft manifest and return the `$set` it wrote. */
async function finalizeWith(over: Record<string, unknown>): Promise<Record<string, unknown>> {
  mockDownload.mockImplementation((key: string) =>
    key.endsWith('_manifest.json')
      ? Promise.resolve(Buffer.from(JSON.stringify(manifest(over))))
      : Promise.resolve(Buffer.from(INDEX_HTML))
  );
  const { res, promise } = post(finalizeHandler, { draftId: DRAFT_ID });
  await promise;
  expect(res._getStatusCode()).toBe(200);
  return (mockFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
}

// ── upload-url: request body -> the draft manifest written to storage ──

const uploadBody = (over: Record<string, unknown> = {}) => ({
  tier: 'user',
  scopeId: 'owner1',
  // SlugSchema's floor is 3 chars; finalize reads the slug off an already-issued draft, whose own
  // schema is a plain string, which is why its fixture can be shorter.
  slug: 'doc',
  title: 'My Artifact',
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
  ...over,
});

/** Run upload-url and return the draft manifest it uploaded. */
async function draftFrom(over: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { res, promise } = post(uploadUrlHandler, uploadBody(over));
  await promise;
  expect(res._getStatusCode()).toBe(200);
  const call = mockUpload.mock.calls.find(c => String(c[1]).endsWith('_manifest.json'));
  return JSON.parse(String(call![0]));
}

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null); // first publish (no previous)
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

describe('finalize - publish-time tag write', () => {
  it('writes normalized tags when the draft supplies them', async () => {
    expect((await finalizeWith({ tags: ['IonQ', 'Weekly'] })).tags).toEqual(['ionq', 'weekly']);
  });

  it('writes nothing when the field is absent', async () => {
    // The in-app publisher omits the key entirely; a re-publish must not disturb existing tags.
    expect('tags' in (await finalizeWith({}))).toBe(false);
  });

  it('writes nothing for an EMPTY array, so a re-publish cannot clear existing tags', async () => {
    // The regression: `[]` is truthy, so `tags ? ... : {}` emitted `{ tags: [] }` and wiped them.
    expect('tags' in (await finalizeWith({ tags: [] }))).toBe(false);
  });

  it('writes nothing when every supplied tag normalizes away', async () => {
    // The hole a RAW-length guard leaves: `['  ']` passes `tags?.length` and then normalizes to
    // `[]`, reaching the write as "clear the tags" - the exact case the guard exists to prevent.
    expect('tags' in (await finalizeWith({ tags: ['   '] }))).toBe(false);
    expect('tags' in (await finalizeWith({ tags: ['', '  ', '\t'] }))).toBe(false);
  });

  it('normalizes identically at publish time and at PATCH time', async () => {
    // Two doors onto one field: a tag typed in the UI and a tag sent by the CLI must land the same,
    // or one label ends up stored two ways depending on how it arrived.
    const written = await finalizeWith({ tags: ['  IonQ ', 'ionq', 'Security   Review', ''] });
    expect(written.tags).toEqual(['ionq', 'security review']);
  });
});

describe('upload-url - tags carried on the draft', () => {
  it('carries normalized tags so finalize can write them in the same publish call', async () => {
    expect((await draftFrom({ tags: ['IonQ', 'Weekly'] })).tags).toEqual(['ionq', 'weekly']);
  });

  it('carries no tags key when the caller omits the field', async () => {
    expect((await draftFrom({})).tags).toBeUndefined();
  });

  it('carries no tags key for an empty array, so `[]` never travels as "clear the tags"', async () => {
    expect((await draftFrom({ tags: [] })).tags).toBeUndefined();
  });

  it('carries no tags key when every supplied tag normalizes away', async () => {
    expect((await draftFrom({ tags: ['   ', ''] })).tags).toBeUndefined();
  });
});

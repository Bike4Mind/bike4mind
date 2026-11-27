import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoad = vi.fn();
const mockCurrent = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockUpdateOne = vi.fn();

vi.mock('@bike4mind/database', () => ({
  liveShareTokenMatch: () => ({ revokedAt: null }),
  PublishedArtifact: {
    findOne: () => ({
      select: () => ({ lean: () => Promise.resolve(mockCurrent()) }),
      lean: () => Promise.resolve(mockLoad()),
    }),
    findOneAndUpdate: () => ({ lean: () => Promise.resolve(mockFindOneAndUpdate()) }),
    updateOne: (...a: unknown[]) => Promise.resolve(mockUpdateOne(...a)),
  },
  liveShareTokens: (artifact: { shareTokens?: { token?: string; revokedAt?: Date | null }[] }) =>
    (artifact.shareTokens ?? []).filter(entry => !!entry.token && !entry.revokedAt),
}));
vi.mock('@server/services/publish', () => ({ generateShareToken: () => 'TESTTOKEN' }));
vi.mock('./organizationPolicy', () => ({ assertPublicationPublicLink: async () => undefined }));

import {
  absoluteShareLinkUrl,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  type ShareLinkView,
} from './shareLinks';
import { PublishServiceError } from './publishServiceError';

const owner = { id: 'owner1' };
const logger = { info: vi.fn() };
const base = { user: owner, logger, publicId: 'pub1' };
const entry = (id: string, token: string) => ({ _id: id, token, revokedAt: null, viewCount: 2 });
const artifact = (shareTokens: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  ownerId: 'owner1',
  shareTokens,
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<PublishServiceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(PublishServiceError);
  return error as PublishServiceError;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue(artifact());
});

describe('share link ownership', () => {
  it('maps missing, unknown and foreign artifacts to 400, 404 and 403', async () => {
    expect((await refusal(listShareLinks({ ...base, publicId: '' }))).statusCode).toBe(400);
    mockLoad.mockResolvedValue(null);
    expect((await refusal(listShareLinks(base))).statusCode).toBe(404);
    mockLoad.mockResolvedValue(artifact([], { ownerId: 'someone-else' }));
    expect((await refusal(listShareLinks(base))).statusCode).toBe(403);
    await expect(listShareLinks({ ...base, user: { id: 'admin', isAdmin: true } })).resolves.toEqual([]);
  });
});

describe('listShareLinks', () => {
  it('returns full tokens for the live links only', async () => {
    mockLoad.mockResolvedValue(artifact([entry('a', 'T1'), { ...entry('b', 'T2'), revokedAt: new Date() }]));
    const links: ShareLinkView[] = await listShareLinks(base);
    expect(links).toEqual([expect.objectContaining({ id: 'a', shareToken: 'T1', shareUrl: '/a/T1', viewCount: 2 })]);
  });
});

describe('createShareLink', () => {
  it('returns the newest live link without writing', async () => {
    mockLoad.mockResolvedValue(artifact([entry('a', 'T1'), entry('b', 'T2')]));
    const created = await createShareLink(base);
    expect(created).toMatchObject({ id: 'b', shareToken: 'T2', shareUrl: '/a/T2', expiresAt: null });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('mints a link and reports its expiry', async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    mockFindOneAndUpdate.mockResolvedValue(artifact([entry('x', 'TESTTOKEN')]));
    const created = await createShareLink({ ...base, expiresAt });
    expect(created).toMatchObject({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    expect(created.expiresAt?.toISOString()).toBe(expiresAt);
    expect(created.shareLinks).toHaveLength(1);
  });

  it('rejects a bad expiry and conflicting modes with their codes', async () => {
    expect((await refusal(createShareLink({ ...base, expiresAt: 'tomorrow' }))).errorCode).toBe(
      'INVALID_SHARE_LINK_EXPIRY'
    );
    const conflict = await refusal(createShareLink({ ...base, regenerate: true, additional: true }));
    expect(conflict).toMatchObject({ statusCode: 400, errorCode: 'CONFLICTING_MINT_MODE' });
  });

  it('refuses an additional link at the live cap', async () => {
    mockLoad.mockResolvedValue(artifact(Array.from({ length: 20 }, (_, i) => entry(`e${i}`, `T${i}`))));
    expect(await refusal(createShareLink({ ...base, additional: true }))).toMatchObject({
      statusCode: 400,
      errorCode: 'SHARE_LINK_LIMIT',
    });
  });

  it('raises SHARE_LINK_RACED when an additional mint loses the write race', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockCurrent.mockResolvedValue(artifact([entry('a', 'T1')]));
    expect(await refusal(createShareLink({ ...base, additional: true }))).toMatchObject({
      statusCode: 409,
      errorCode: 'SHARE_LINK_RACED',
    });
  });

  it('raises SHARE_LINK_RACED when a plain mint loses and the link is gone again', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockCurrent.mockResolvedValue(artifact());
    expect((await refusal(createShareLink(base))).errorCode).toBe('SHARE_LINK_RACED');
  });
});

describe('revokeShareLink', () => {
  it('revokes everything without an id', async () => {
    mockLoad.mockResolvedValue(artifact([entry('a', 'T1'), entry('b', 'T2')]));
    await expect(revokeShareLink(base)).resolves.toEqual({ revoked: true, remaining: 0 });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid or unknown id', async () => {
    expect((await refusal(revokeShareLink({ ...base, id: 'nope' }))).statusCode).toBe(400);
    const unknown = await refusal(revokeShareLink({ ...base, id: '507f1f77bcf86cd799439011' }));
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses to revoke the last link behind a gate', async () => {
    mockLoad.mockResolvedValue(
      artifact([entry('a', 'T1')], { accessGate: { kind: 'passphrase' }, visibility: 'link' })
    );
    expect(await refusal(revokeShareLink(base))).toMatchObject({
      statusCode: 400,
      errorCode: 'REVOKE_WOULD_ORPHAN_GATE',
    });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe('absoluteShareLinkUrl', () => {
  it('joins the app origin without a doubled slash', () => {
    vi.stubEnv('APP_URL', 'https://app.example.test/');
    expect(absoluteShareLinkUrl('/a/T1')).toBe('https://app.example.test/a/T1');
    vi.unstubAllEnvs();
  });
});

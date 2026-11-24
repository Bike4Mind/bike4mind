// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findServable: vi.fn(),
  recordTry: vi.fn(),
  importListing: vi.fn(),
  importRow: vi.fn(),
  findSkill: vi.fn(),
  audience: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  SkillListingImport: { findOne: () => ({ select: () => ({ lean: h.importRow }) }) },
  skillRepository: { findById: h.findSkill },
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({
  audienceIdsFor: h.audience,
  canSeeListing: (
    listing: { visibility: string; organizationId?: string; shareToken?: string },
    audience: { orgIds: string[] },
    token?: string
  ) =>
    listing.visibility === 'public' ||
    (listing.visibility === 'organization' && audience.orgIds.includes(listing.organizationId ?? '')) ||
    (listing.visibility === 'unlisted' && token === listing.shareToken),
}));
vi.mock('./importListing', () => ({ importListing: h.importListing }));
vi.mock('./templatePage', () => ({ findServableTemplate: h.findServable, recordTemplateTry: h.recordTry }));

import { tryTemplate } from './templateTry';

const VISITOR = { id: 'visitor-1' };
const template = { _id: 't1', listingId: 'l1', slug: 'article-bullets', examplePrompt: 'Turn this into bullets' };
const listing = (extra: Record<string, unknown> = {}) => ({
  id: 'l1',
  authorUserId: 'author-1',
  sourceSkillId: 'source-1',
  visibility: 'public',
  shareToken: 'share-token-1',
  ...extra,
});
const serve = (extra: Record<string, unknown> = {}) =>
  h.findServable.mockResolvedValue({ template, listing: listing(extra) });
const nameTaken = (suggestedName?: string) =>
  new ConflictError('You already have a skill named "article-bullets"', { code: 'name_taken', suggestedName });

beforeEach(() => {
  vi.clearAllMocks();
  h.audience.mockResolvedValue({ orgIds: [], spaceIds: [] });
  h.importRow.mockResolvedValue(null);
  h.recordTry.mockResolvedValue(undefined);
});

describe('tryTemplate', () => {
  it('404s when the template page is not live', async () => {
    h.findServable.mockResolvedValue(null);
    await expect(tryTemplate(VISITOR, 'gone')).rejects.toMatchObject({ statusCode: 404 });
    expect(h.importListing).not.toHaveBeenCalled();
    expect(h.recordTry).not.toHaveBeenCalled();
  });

  it('imports the listing when the visitor has no copy, and counts the try', async () => {
    serve();
    h.importListing.mockResolvedValue({ skill: { id: 's1', name: 'article-bullets' }, created: true });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toEqual({
      skillName: 'article-bullets',
      examplePrompt: 'Turn this into bullets',
      imported: true,
    });
    expect(h.importListing).toHaveBeenCalledWith(VISITOR, 'l1', { token: undefined });
    expect(h.recordTry).toHaveBeenCalledWith(template);
  });

  it("reuses the visitor's existing copy without importing again", async () => {
    serve();
    h.importRow.mockResolvedValue({ skillId: 'copy-1' });
    h.findSkill.mockResolvedValue({
      id: 'copy-1',
      name: 'my-bullets',
      userId: 'visitor-1',
      importedFrom: { listingId: 'l1' },
    });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toMatchObject({ skillName: 'my-bullets', imported: false });
    expect(h.importListing).not.toHaveBeenCalled();
    expect(h.recordTry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deleted', { deletedAt: new Date() }],
    ['detached from the listing', { importedFrom: undefined }],
    ['owned by someone else', { userId: 'someone-else' }],
  ])('imports again when the earlier copy is %s', async (_case, extra) => {
    serve();
    h.importRow.mockResolvedValue({ skillId: 'copy-1' });
    h.findSkill.mockResolvedValue({
      id: 'copy-1',
      name: 'article-bullets',
      userId: 'visitor-1',
      importedFrom: { listingId: 'l1' },
      ...extra,
    });
    h.importListing.mockResolvedValue({ skill: { id: 's2', name: 'article-bullets' }, created: true });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toMatchObject({ imported: true });
    expect(h.importListing).toHaveBeenCalledTimes(1);
  });

  it('saves under the suggested suffixed name when the visitor has a different skill with that name', async () => {
    serve();
    h.importListing
      .mockRejectedValueOnce(nameTaken('article-bullets-2'))
      .mockResolvedValueOnce({ skill: { id: 's2', name: 'article-bullets-2' }, created: true });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toMatchObject({ skillName: 'article-bullets-2' });
    expect(h.importListing).toHaveBeenNthCalledWith(2, VISITOR, 'l1', { token: undefined, name: 'article-bullets-2' });
  });

  it('takes the next suggestion when a concurrent import claims the suffixed name first', async () => {
    serve();
    h.importListing
      .mockRejectedValueOnce(nameTaken('article-bullets-2'))
      .mockRejectedValueOnce(nameTaken('article-bullets-3'))
      .mockResolvedValueOnce({ skill: { id: 's3', name: 'article-bullets-3' }, created: true });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toMatchObject({ skillName: 'article-bullets-3' });
  });

  it('gives up with a 409 when no suffixed name is free', async () => {
    serve();
    h.importListing.mockRejectedValue(nameTaken(undefined));
    await expect(tryTemplate(VISITOR, 'article-bullets')).rejects.toMatchObject({ statusCode: 409 });
    expect(h.recordTry).not.toHaveBeenCalled();
  });

  it('carries the share token of an unlisted listing to the import', async () => {
    serve({ visibility: 'unlisted' });
    h.importListing.mockResolvedValue({ skill: { id: 's1', name: 'article-bullets' }, created: true });

    await tryTemplate(VISITOR, 'article-bullets');
    expect(h.importListing).toHaveBeenCalledWith(VISITOR, 'l1', { token: 'share-token-1' });
  });

  it('404s for an organization listing the visitor is not a member of, even with an earlier copy', async () => {
    serve({ visibility: 'organization', organizationId: 'org-1' });
    h.importRow.mockResolvedValue({ skillId: 'copy-1' });
    await expect(tryTemplate(VISITOR, 'article-bullets')).rejects.toMatchObject({ statusCode: 404 });
    expect(h.findSkill).not.toHaveBeenCalled();
  });

  it("opens the author's own source skill instead of importing", async () => {
    serve({ authorUserId: 'visitor-1' });
    h.findSkill.mockResolvedValue({ id: 'source-1', name: 'article-bullets', userId: 'visitor-1' });

    expect(await tryTemplate(VISITOR, 'article-bullets')).toMatchObject({
      skillName: 'article-bullets',
      imported: false,
    });
    expect(h.findSkill).toHaveBeenCalledWith('source-1');
    expect(h.importListing).not.toHaveBeenCalled();
  });

  it('still answers when the try count cannot be written', async () => {
    serve();
    h.importListing.mockResolvedValue({ skill: { id: 's1', name: 'article-bullets' }, created: true });
    h.recordTry.mockRejectedValue(new Error('db down'));
    const logger = { warn: vi.fn() };

    expect(await tryTemplate(VISITOR, 'article-bullets', logger)).toMatchObject({ skillName: 'article-bullets' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('try count'), expect.any(Error));
  });
});

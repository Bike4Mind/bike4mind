import { describe, it, expect, vi } from 'vitest';

// baseApi wraps the handler; mock it as a thin pass-through so importing the module
// (for the exported `filterServeableFilePaths` helper) doesn't pull in real auth/DB
// middleware. Mirrors the style used in `download.test.ts`.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: unknown) => h }),
}));

// SST Resource is not available in test environments - mock the bucket name.
vi.mock('sst', () => ({
  Resource: { fabFileBucket: { name: 'test-fabfile-bucket' } },
}));

// The route module imports these only for the real handler; the helper under test takes its
// lookup + isAccessible as plain functions, so minimal mocks satisfy the module's top-level imports.
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: vi.fn() },
  fabFileRepository: { shareable: { findAccessibleById: vi.fn() } },
}));
vi.mock('@server/dataLakes', () => ({
  grantingLakes: vi.fn(),
  resolveAccessibleLakes: vi.fn(),
}));

import { filterServeableFilePaths } from '../presigned-url';

// The ownership axis is exercised separately below; these moderation cases grant access to all.
const allowAll = async () => true;

describe('filterServeableFilePaths', () => {
  // isImageServeable gates on moderationStatus alone now (no mimeType special-case), so an
  // unscanned non-image ('doc.pdf' below) is held exactly like an unscanned image - the
  // declared mimeType is client-controlled and only corrected by the async S3-event scan.
  it('drops a filePath whose FabFile is a pending image or an unscanned non-image, keeps a clean image and a clean non-image', async () => {
    const lookup = vi.fn(async (filePath: string) => {
      switch (filePath) {
        case 'held.png':
          return { _id: 'h', mimeType: 'image/png', moderationStatus: 'pending' };
        case 'clean.png':
          return { _id: 'c', mimeType: 'image/png', moderationStatus: 'clean' };
        case 'doc.pdf':
          return { _id: 'd', mimeType: 'application/pdf' };
        case 'clean.pdf':
          return { _id: 'p', mimeType: 'application/pdf', moderationStatus: 'clean' };
        default:
          return null;
      }
    });

    const result = await filterServeableFilePaths(['held.png', 'clean.png', 'doc.pdf', 'clean.pdf'], lookup, allowAll);

    expect(result).toEqual([null, 'clean.png', null, 'clean.pdf']);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('drops a blocked image and denies an untracked, non-allowlisted key (deny-by-default)', async () => {
    const lookup = vi.fn(async (filePath: string) => {
      if (filePath === 'blocked.png') return { _id: 'b', mimeType: 'image/png', moderationStatus: 'blocked' };
      return null; // no FabFile record - an untracked, non-allowlisted key is no longer signed.
    });

    const result = await filterServeableFilePaths(['blocked.png', 'exports/leak.json'], lookup, allowAll);

    expect(result).toEqual([null, null]);
  });

  it('drops a filePath whose FabFile has no moderationStatus yet (undefined/pending scan, fail-closed)', async () => {
    const lookup = vi.fn(async () => ({ _id: 'm', mimeType: 'image/jpeg' }));

    const result = await filterServeableFilePaths(['mid-scan.jpg'], lookup, allowAll);

    expect(result).toEqual([null]);
  });

  it('drops a clean, tracked file the caller may not access (IDOR guard) but keeps their own', async () => {
    const lookup = vi.fn(async (filePath: string) => ({
      _id: filePath === 'mine.png' ? 'mine' : 'theirs',
      mimeType: 'image/png',
      moderationStatus: 'clean',
    }));
    // Access granted only for the caller's own file id.
    const isAccessible = vi.fn(async (fabFile: { _id: unknown }) => fabFile._id === 'mine');

    const result = await filterServeableFilePaths(['mine.png', 'theirs.png'], lookup, isAccessible);

    expect(result).toEqual(['mine.png', null]);
  });

  it('denies an untracked, non-allowlisted key without consulting the access check', async () => {
    const lookup = vi.fn(async () => null);
    const isAccessible = vi.fn(async () => false);

    const result = await filterServeableFilePaths(['exports/leak.json'], lookup, isAccessible);

    expect(result).toEqual([null]);
    expect(isAccessible).not.toHaveBeenCalled();
  });

  // Allowlisted ownerless-serveable prefix (admin "What's New" modal images). This is the P1
  // regression: modal images ARE tracked FabFiles, so a plain owner check 404s them for every
  // non-admin. The prefix allowlist serves them regardless of owner, whether or not they have a row.
  it('serves an allowlisted prefix even for a tracked file the caller may not access, without the access check', async () => {
    const lookup = vi.fn(async () => ({ _id: 'modal', mimeType: 'image/png', moderationStatus: 'clean' }));
    const isAccessible = vi.fn(async () => false); // caller is not owner/share of this modal image

    const result = await filterServeableFilePaths(['modals/whats-new.png'], lookup, isAccessible);

    expect(result).toEqual(['modals/whats-new.png']);
    expect(isAccessible).not.toHaveBeenCalled();
  });

  it('serves an allowlisted prefix that has no FabFile row (untracked modal key)', async () => {
    const lookup = vi.fn(async () => null);
    const isAccessible = vi.fn(async () => false);

    const result = await filterServeableFilePaths(['modals/orphaned.png'], lookup, isAccessible);

    expect(result).toEqual(['modals/orphaned.png']);
    expect(isAccessible).not.toHaveBeenCalled();
  });

  it('still withholds an allowlisted-prefix image that is held by moderation (allowlist does not bypass moderation)', async () => {
    const lookup = vi.fn(async () => ({ _id: 'modal', mimeType: 'image/png', moderationStatus: 'pending' }));

    const result = await filterServeableFilePaths(['modals/pending.png'], lookup, allowAll);

    expect(result).toEqual([null]);
  });
});

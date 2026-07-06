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

// The route module imports FabFile only to look files up in the real handler; the helper
// under test takes its lookup as a plain function, so a minimal mock is enough to satisfy
// the module's top-level import.
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: vi.fn() },
}));

import { filterServeableFilePaths } from '../presigned-url';

describe('filterServeableFilePaths', () => {
  // isImageServeable gates on moderationStatus alone now (no mimeType special-case), so an
  // unscanned non-image ('doc.pdf' below) is held exactly like an unscanned image - the
  // declared mimeType is client-controlled and only corrected by the async S3-event scan.
  it('drops a filePath whose FabFile is a pending image or an unscanned non-image, keeps a clean image and a clean non-image', async () => {
    const lookup = vi.fn(async (filePath: string) => {
      switch (filePath) {
        case 'held.png':
          return { mimeType: 'image/png', moderationStatus: 'pending' };
        case 'clean.png':
          return { mimeType: 'image/png', moderationStatus: 'clean' };
        case 'doc.pdf':
          return { mimeType: 'application/pdf' };
        case 'clean.pdf':
          return { mimeType: 'application/pdf', moderationStatus: 'clean' };
        default:
          return null;
      }
    });

    const result = await filterServeableFilePaths(['held.png', 'clean.png', 'doc.pdf', 'clean.pdf'], lookup);

    expect(result).toEqual([null, 'clean.png', null, 'clean.pdf']);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('drops a blocked image and keeps an untracked filePath (no FabFile record found)', async () => {
    const lookup = vi.fn(async (filePath: string) => {
      if (filePath === 'blocked.png') return { mimeType: 'image/png', moderationStatus: 'blocked' };
      return null; // no FabFile record - this route also serves arbitrary S3 keys.
    });

    const result = await filterServeableFilePaths(['blocked.png', 'untracked.txt'], lookup);

    expect(result).toEqual([null, 'untracked.txt']);
  });

  it('drops a filePath whose FabFile has no moderationStatus yet (undefined/pending scan, fail-closed)', async () => {
    const lookup = vi.fn(async () => ({ mimeType: 'image/jpeg' }));

    const result = await filterServeableFilePaths(['mid-scan.jpg'], lookup);

    expect(result).toEqual([null]);
  });
});

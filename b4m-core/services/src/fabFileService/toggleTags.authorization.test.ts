import { describe, it, expect, vi } from 'vitest';
import { Permission } from '@bike4mind/common';
import { toggleTags } from './toggleTags';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('toggleTags authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  // Non-enumerable toJSON, as the sibling toggleTags.test.ts does: the service serializes the
  // documents it returns, and a bare plain object does not behave like the hydrated one it gets.
  const sharedFile = (permissions: Permission[]) => {
    const doc = {
      id: 'file-1',
      userId: OWNER,
      tags: [] as { name: string; strength: number }[],
      users: [{ userId: SHAREE, permissions }],
      groups: [],
    };
    Object.defineProperty(doc, 'toJSON', { value: () => ({ ...doc }), enumerable: false });
    return doc;
  };

  const adaptersFor = (file: ReturnType<typeof sharedFile>, actorId: string) => {
    const pushTagsByFabFileId = vi.fn().mockResolvedValue(1);
    const pullTagsByFabFileId = vi.fn().mockResolvedValue(1);
    return {
      pushTagsByFabFileId,
      pullTagsByFabFileId,
      adapters: {
        db: {
          fabFiles: {
            shareable: createShareableFake([file as never]),
            findById: vi.fn().mockResolvedValue(file),
            pushTagsByFabFileId,
            pullTagsByFabFileId,
            computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
          },
          fileTags: { touchLastActivityBy: vi.fn() },
          dataLakes: {
            findByDatalakeTag: vi.fn().mockResolvedValue(null),
            setStats: vi.fn(),
            activateIfDraft: vi.fn(),
            find: vi.fn().mockResolvedValue([]),
          },
          users: { findById: vi.fn().mockResolvedValue({ id: actorId, isAdmin: false }) },
        },
      },
    };
  };

  it('refuses a read-only sharee tagging the owner file, and writes no tag', async () => {
    const file = sharedFile([Permission.read]);
    const { adapters, pushTagsByFabFileId, pullTagsByFabFileId } = adaptersFor(file, SHAREE);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toggleTags(SHAREE, { ids: ['file-1'], tags: ['mine'] }, adapters as any)
    ).rejects.toThrow(/not accessible or you do not have permission/i);

    expect(pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(file.tags).toEqual([]);
  });

  it('still allows a sharee holding update to tag the file', async () => {
    const file = sharedFile([Permission.read, Permission.update]);
    const { adapters, pushTagsByFabFileId } = adaptersFor(file, SHAREE);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toggleTags(SHAREE, { ids: ['file-1'], tags: ['mine'] }, adapters as any);

    expect(pushTagsByFabFileId).toHaveBeenCalled();
  });
});

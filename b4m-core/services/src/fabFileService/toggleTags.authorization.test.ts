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

/**
 * A meta-tag write that newly satisfies a lake's membership condition is a separate, narrower
 * decision from "may this actor tag this file at all". Holding `update` on a shared file is enough
 * to tag it; it is NOT enough to stamp a lake meta-tag that pulls the owner's file into a lake the
 * actor controls. Membership IS read access, and a lake delete/purge reaches its members, so the
 * join has to turn on who owns the FILE rather than on who can write to it.
 */
describe('toggleTags - joining a lake with someone else"s file', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';
  const LAKE_TAG = 'datalake:sharee-lake';

  const fileOwnedBy = (userId: string) => {
    const doc = {
      id: 'file-1',
      userId,
      tags: [] as { name: string; strength: number }[],
      users: [{ userId: SHAREE, permissions: [Permission.read, Permission.update] }],
      groups: [],
    };
    Object.defineProperty(doc, 'toJSON', { value: () => ({ ...doc }), enumerable: false });
    return doc;
  };

  // The lake belongs to the SHAREE, which is the point: they are its effective owner and would pass
  // every lake-side manage gate. Only the file-ownership conjunct stands between them and the join.
  const shareeLake = {
    id: 'lake-1',
    name: 'Sharee Lake',
    slug: 'sharee-lake',
    datalakeTag: LAKE_TAG,
    fileTagPrefix: 'sl:',
    createdByUserId: SHAREE,
    status: 'active',
  };

  const adaptersFor = (file: ReturnType<typeof fileOwnedBy>, actorId: string) => {
    const pushTagsByFabFileId = vi.fn().mockResolvedValue(1);
    return {
      pushTagsByFabFileId,
      adapters: {
        db: {
          fabFiles: {
            shareable: createShareableFake([file as never]),
            findById: vi.fn().mockResolvedValue(file),
            pushTagsByFabFileId,
            pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
            computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
          },
          fileTags: { touchLastActivityBy: vi.fn() },
          dataLakes: {
            findByDatalakeTag: vi.fn().mockResolvedValue(shareeLake),
            setStats: vi.fn(),
            activateIfDraft: vi.fn(),
            find: vi.fn().mockResolvedValue([]),
          },
          users: { findById: vi.fn().mockResolvedValue({ id: actorId, isAdmin: false }) },
        },
      },
    };
  };

  it('refuses a sharee stamping their own lake meta-tag on the owner file, and writes no tag', async () => {
    const file = fileOwnedBy(OWNER);
    const { adapters, pushTagsByFabFileId } = adaptersFor(file, SHAREE);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toggleTags(SHAREE, { ids: ['file-1'], tags: [LAKE_TAG] }, adapters as any)
    ).rejects.toThrow(/permission to add files to this data lake/i);

    // All-or-nothing: the refusal is graded before any write, so the file does not end up with the
    // membership tag stamped and the failure reported afterwards.
    expect(pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(file.tags).toEqual([]);
  });

  // The positive control that makes the refusal meaningful: same actor, same lake, same tag. Only
  // the file's owner changes, so nothing about the lake or the tag is being rejected outright.
  it('allows that same actor to join a file they own to that same lake', async () => {
    const file = fileOwnedBy(SHAREE);
    const { adapters, pushTagsByFabFileId } = adaptersFor(file, SHAREE);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toggleTags(SHAREE, { ids: ['file-1'], tags: [LAKE_TAG] }, adapters as any);

    expect(pushTagsByFabFileId).toHaveBeenCalled();
  });
});

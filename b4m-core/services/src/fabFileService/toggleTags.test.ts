import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { IUserDocument } from '@bike4mind/common';
import { toggleTags } from './toggleTags';

type FileTag = { name: string; strength: number };
type FabFile = { id: string; tags: FileTag[] };

describe('toggleTags (reconcileTags port)', () => {
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findAllAccessibleByIds: Mock;
  let dbUpdate: Mock;
  let incrementFileCountBy: Mock;
  let reconcileTags: Mock;
  let filesById: Record<string, FabFile>;
  let mockAdapters: {
    db: {
      fabFiles: { shareable: { findAllAccessibleByIds: Mock }; update: Mock };
      fileTags: { incrementFileCountBy: Mock };
      users: { findById: Mock };
    };
    reconcileTags: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    filesById = {};

    findAllAccessibleByIds = vi
      .fn()
      .mockImplementation(async (_user: IUserDocument, ids: string[]) => ids.map(id => filesById[id]));
    dbUpdate = vi.fn().mockResolvedValue(undefined);
    incrementFileCountBy = vi.fn().mockResolvedValue(undefined);
    // Appends a stamped tag so the reconciled output is always visibly different from
    // whatever post-toggle array it was handed - a no-op port would fail every assertion here.
    reconcileTags = vi
      .fn()
      .mockImplementation(async (tags: FileTag[]) => [...tags, { name: 'acme:uncategorized', strength: 1 }]);

    mockAdapters = {
      db: {
        fabFiles: { shareable: { findAllAccessibleByIds }, update: dbUpdate },
        fileTags: { incrementFileCountBy },
        users: { findById: vi.fn().mockResolvedValue(mockUser) },
      },
      reconcileTags,
    };
  });

  it('persists the reconciler output, not the raw post-toggle array', async () => {
    filesById['file-1'] = { id: 'file-1', tags: [{ name: 'design', strength: 1 }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toggleTags('user-123', { ids: ['file-1'], tags: ['urgent'] }, mockAdapters as any);

    expect(reconcileTags).toHaveBeenCalledOnce();
    const [postToggleArg] = reconcileTags.mock.calls[0];
    expect(postToggleArg).toEqual([
      { name: 'design', strength: 1 },
      { name: 'urgent', strength: 0 },
    ]);

    expect(dbUpdate).toHaveBeenCalledOnce();
    const persisted = dbUpdate.mock.calls[0][0];
    // The raw post-toggle array has no 'acme:uncategorized' entry - only the reconciler adds it.
    expect(persisted.tags).toEqual([
      { name: 'design', strength: 1 },
      { name: 'urgent', strength: 0 },
      { name: 'acme:uncategorized', strength: 1 },
    ]);
  });

  it('passes previousTags reflecting the pre-toggle state, not the tag just toggled on', async () => {
    filesById['file-1'] = { id: 'file-1', tags: [{ name: 'design', strength: 1 }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toggleTags('user-123', { ids: ['file-1'], tags: ['urgent'] }, mockAdapters as any);

    const [postToggleArg, previousTagsArg] = reconcileTags.mock.calls[0];
    expect(postToggleArg.some((t: FileTag) => t.name === 'urgent')).toBe(true);
    expect(previousTagsArg).toEqual([{ name: 'design', strength: 1 }]);
    expect(previousTagsArg.some((t: FileTag) => t.name === 'urgent')).toBe(false);
  });

  it('still reconciles when a lake meta-tag is toggled OFF, and persists the reconciler output', async () => {
    filesById['file-1'] = { id: 'file-1', tags: [{ name: 'acme:lake', strength: 1 }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await toggleTags('user-123', { ids: ['file-1'], tags: ['acme:lake'] }, mockAdapters as any);

    expect(reconcileTags).toHaveBeenCalledOnce();
    const [postToggleArg, previousTagsArg] = reconcileTags.mock.calls[0];
    // The meta-tag was present, so toggling it removes it from the post-toggle array.
    expect(postToggleArg).toEqual([]);
    expect(previousTagsArg).toEqual([{ name: 'acme:lake', strength: 1 }]);

    const persisted = dbUpdate.mock.calls[0][0];
    expect(persisted.tags).toEqual([{ name: 'acme:uncategorized', strength: 1 }]);
  });

  it('reconciles each file independently in a multi-file call, with its own previousTags', async () => {
    filesById['file-1'] = { id: 'file-1', tags: [{ name: 'a', strength: 1 }] };
    filesById['file-2'] = { id: 'file-2', tags: [{ name: 'b', strength: 1 }] };

    await toggleTags(
      'user-123',
      { ids: ['file-1', 'file-2'], tags: ['urgent'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockAdapters as any
    );

    expect(reconcileTags).toHaveBeenCalledTimes(2);
    expect(dbUpdate).toHaveBeenCalledTimes(2);

    const callForFile1 = reconcileTags.mock.calls.find(([tags]) => tags.some((t: FileTag) => t.name === 'a'));
    const callForFile2 = reconcileTags.mock.calls.find(([tags]) => tags.some((t: FileTag) => t.name === 'b'));

    expect(callForFile1[0]).toEqual([
      { name: 'a', strength: 1 },
      { name: 'urgent', strength: 0 },
    ]);
    expect(callForFile1[1]).toEqual([{ name: 'a', strength: 1 }]);

    expect(callForFile2[0]).toEqual([
      { name: 'b', strength: 1 },
      { name: 'urgent', strength: 0 },
    ]);
    expect(callForFile2[1]).toEqual([{ name: 'b', strength: 1 }]);

    const persistedTagSets = dbUpdate.mock.calls.map(([f]) => f.tags);
    expect(persistedTagSets).toContainEqual([
      { name: 'a', strength: 1 },
      { name: 'urgent', strength: 0 },
      { name: 'acme:uncategorized', strength: 1 },
    ]);
    expect(persistedTagSets).toContainEqual([
      { name: 'b', strength: 1 },
      { name: 'urgent', strength: 0 },
      { name: 'acme:uncategorized', strength: 1 },
    ]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { list } from './list';
import { IArtifactRepository } from '@bike4mind/common';

/**
 * `includeDeleted` is the only thing standing between a caller and a soft-deleted artifact: the
 * Mongoose ArtifactSchema registers no soft-delete plugin, so there is no `pre('find')` backstop
 * the way Group/Organization/FabFile have. These assert the filter the service actually hands the
 * repository, on both the plain-find and text-search paths.
 */
describe('artifactService - list includeDeleted', () => {
  const makeAdapters = () => {
    const find = vi.fn().mockResolvedValue([]);
    const searchByText = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    return {
      adapters: { db: { artifacts: { find, searchByText, count } as unknown as IArtifactRepository } },
      find,
      searchByText,
    };
  };

  const params = (over: Partial<Parameters<typeof list>[1]> = {}): Parameters<typeof list>[1] => ({
    limit: 20,
    offset: 0,
    sortBy: 'updatedAt',
    sortOrder: 'desc',
    includeDeleted: false,
    ...over,
  });

  it('excludes soft-deleted rows by default', async () => {
    const { adapters, find } = makeAdapters();

    await list('user-1', params(), adapters);

    expect(find).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', deletedAt: null }));
  });

  it('omits the deletedAt filter when includeDeleted is true', async () => {
    const { adapters, find } = makeAdapters();

    await list('user-1', params({ includeDeleted: true }), adapters);

    const filter = find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).not.toHaveProperty('deletedAt');
  });

  it('passes includeDeleted through to the text search rather than letting it default', async () => {
    // searchByText applies its own live-only default, so the flag has to be handed over explicitly
    // or a search silently ignores it.
    const { adapters, searchByText, find } = makeAdapters();

    await list('user-1', params({ includeDeleted: true, search: 'needle' }), adapters);

    expect(find).not.toHaveBeenCalled();
    expect(searchByText).toHaveBeenCalledWith('needle', expect.any(Object), true);
  });

  it('tells the text search to exclude deleted rows by default', async () => {
    const { adapters, searchByText } = makeAdapters();

    await list('user-1', params({ search: 'needle' }), adapters);

    expect(searchByText).toHaveBeenCalledWith('needle', expect.objectContaining({ deletedAt: null }), false);
  });
});

describe('artifactService - list identifier filter', () => {
  const makeAdapters = () => {
    const find = vi.fn().mockResolvedValue([]);
    return { adapters: { db: { artifacts: { find } as unknown as IArtifactRepository } }, find };
  };

  const params = (over: Record<string, unknown> = {}) =>
    ({
      limit: 1,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      includeDeleted: false,
      sessionId: 's1',
      type: 'react',
      ...over,
    }) as Parameters<typeof list>[1];

  it('matches the identifier field, or metadata.originalIdentifier on rows written before the field', async () => {
    const { adapters, find } = makeAdapters();

    await list('user-1', params({ identifier: 'todo_app' }), adapters);

    expect(find).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 's1',
      type: 'react',
      deletedAt: null,
      $or: [{ identifier: 'todo_app' }, { identifier: { $exists: false }, 'metadata.originalIdentifier': 'todo_app' }],
    });
  });

  it('adds no identifier clause when none is given', async () => {
    const { adapters, find } = makeAdapters();

    await list('user-1', params(), adapters);

    expect(find.mock.calls[0][0]).not.toHaveProperty('$or');
  });

  it.each([{ $ne: 'x' }, ['a', 'b'], ''])('rejects a non-string or empty identifier (%j)', async identifier => {
    const { adapters, find } = makeAdapters();

    await expect(list('user-1', params({ identifier }), adapters)).rejects.toThrow(/identifier/);
    expect(find).not.toHaveBeenCalled();
  });
});

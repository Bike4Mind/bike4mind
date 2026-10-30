import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFind, mockSort, mockAssign, mockCreateIndexes } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockSort: vi.fn(),
  mockAssign: vi.fn(),
  mockCreateIndexes: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  SkillListing: { find: mockFind, createIndexes: mockCreateIndexes },
  assignClaudePluginName: mockAssign,
}));

import migration from './20260921235963_backfill-skilllisting-claude-plugin-name';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const listings = [
    { _id: 'aaa000000000000000000001', name: 'Foo' },
    { _id: 'aaa000000000000000000002', name: 'Foo' },
  ];
  mockSort.mockReturnValue({ select: async () => listings });
  mockFind.mockReturnValue({ sort: mockSort });
});

describe('backfill-skilllisting-claude-plugin-name', () => {
  it('names unnamed approved Organization listings oldest first, after building the indexes', async () => {
    await migration.up();

    expect(mockFind).toHaveBeenCalledWith({
      visibility: 'organization',
      currentApprovedVersionId: { $ne: null },
      claudePluginName: { $exists: false },
    });
    expect(mockSort).toHaveBeenCalledWith({ _id: 1 });
    expect(mockAssign.mock.calls).toEqual([
      ['aaa000000000000000000001', 'Foo'],
      ['aaa000000000000000000002', 'Foo'],
    ]);
    expect(mockCreateIndexes.mock.invocationCallOrder[0]).toBeLessThan(mockFind.mock.invocationCallOrder[0]);
  });

  it('keeps going when one listing fails to be named', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAssign.mockRejectedValueOnce(new Error('boom'));
    await migration.up();
    expect(mockAssign).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalled();
  });

  it('down writes nothing', async () => {
    await migration.down();
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

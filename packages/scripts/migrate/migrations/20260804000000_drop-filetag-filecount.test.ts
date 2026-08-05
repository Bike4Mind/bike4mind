import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB handle the migration reaches via mongoose.connection.db.
const mockUpdateMany = vi.fn();
const mockCollection = vi.fn(() => ({ updateMany: mockUpdateMany }));
vi.mock('@bike4mind/database', () => ({
  mongoose: {
    connection: {
      get db() {
        return { collection: mockCollection };
      },
    },
  },
}));

import migration from './20260804000000_drop-filetag-filecount';

describe('drop-filetag-filecount migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 4 });
  });

  it('unsets fileCount on the tags collection', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledWith('tags');
    expect(mockUpdateMany).toHaveBeenCalledWith({ fileCount: { $exists: true } }, { $unset: { fileCount: '' } });
  });

  // $exists, not a truthiness test: a tag sitting at fileCount 0 still carries the key and still has
  // to lose it, and it is also what makes a second run a no-op.
  it('selects on key presence so a zero count is not skipped', async () => {
    await migration.up();

    const [filter] = mockUpdateMany.mock.calls[0];
    expect(filter).toEqual({ fileCount: { $exists: true } });
  });

  // Through the raw collection deliberately: the field is gone from FileTagSchema, and mongoose
  // strict mode would strip the $unset out of a model-level update, making the migration a silent
  // no-op. Nothing else in the suite would catch that.
  it('does not route the update through a mongoose model', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('is irreversible rather than restoring a drifted counter', async () => {
    await expect(migration.down!()).resolves.toBeUndefined();

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

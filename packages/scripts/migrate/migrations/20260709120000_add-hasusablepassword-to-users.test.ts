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

import migration from './20260709120000_add-hasusablepassword-to-users';

describe('add-hasusablepassword-to-users migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 2 }).mockResolvedValueOnce({ modifiedCount: 5 });
  });

  it('marks non-empty-password docs as hasUsablePassword=true first', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockUpdateMany).toHaveBeenNthCalledWith(
      1,
      { hasUsablePassword: { $exists: false }, password: { $exists: true, $type: 'string', $ne: '' } },
      { $set: { hasUsablePassword: true } }
    );
  });

  it('marks all remaining (still-missing-the-field) docs as hasUsablePassword=false', async () => {
    await migration.up();

    expect(mockUpdateMany).toHaveBeenNthCalledWith(
      2,
      { hasUsablePassword: { $exists: false } },
      { $set: { hasUsablePassword: false } }
    );
  });

  it('down unsets the field on every doc', async () => {
    mockUpdateMany.mockReset().mockResolvedValueOnce({ modifiedCount: 7 });
    await migration.down();
    expect(mockUpdateMany).toHaveBeenCalledWith({}, { $unset: { hasUsablePassword: '' } });
  });
});

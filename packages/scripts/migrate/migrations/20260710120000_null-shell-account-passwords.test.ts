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

import migration from './20260710120000_null-shell-account-passwords';

describe('null-shell-account-passwords migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
  });

  it('nulls the leftover password only on unverified flag-false docs that still carry one', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { hasUsablePassword: false, emailVerified: false, password: { $type: 'string', $ne: '' } },
      { $set: { password: null } }
    );
  });

  it('never touches hasUsablePassword: true docs (indistinguishable from real-password users)', async () => {
    await migration.up();

    const [filter] = mockUpdateMany.mock.calls[0];
    expect(filter.hasUsablePassword).toBe(false);
    expect(filter).not.toHaveProperty('hasUsablePassword.$ne');
  });

  it('excludes verified accounts so the seeder real-secret QA accounts are never nulled', async () => {
    await migration.up();

    const [filter] = mockUpdateMany.mock.calls[0];
    // Seeder QA/super-admin accounts are emailVerified: true with a real (SSM)
    // password used by admin/emergency-login; this filter must skip them.
    expect(filter.emailVerified).toBe(false);
  });

  it('down is a no-op (irreversible)', async () => {
    await migration.down();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

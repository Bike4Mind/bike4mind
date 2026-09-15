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

vi.mock('@bike4mind/common', () => ({
  GRANDFATHERED_POLICY_VERSION: 'grandfathered',
}));

import migration from './20260702010000_backfill-policy-acceptance-grandfather';

describe('backfill-policy-acceptance-grandfather migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
  });

  it('stamps the sentinel version + timestamp on docs with aupAcceptedVersion absent or null', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledWith('users');
    // Match absent OR null: the schema default (aupAcceptedVersion: null) can materialize the field
    // as null on a legacy doc re-saved in the deploy window, which $exists:false alone would miss.
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { $or: [{ aupAcceptedVersion: { $exists: false } }, { aupAcceptedVersion: null }] },
      { $set: { aupAcceptedVersion: 'grandfathered', aupAcceptedAt: expect.any(Date) } }
    );
  });

  it('does not fabricate an age attestation for grandfathered users', async () => {
    await migration.up();
    const setClause = mockUpdateMany.mock.calls[0][1].$set;
    expect(setClause).not.toHaveProperty('ageAttestedAdult');
  });

  it('down is a no-op (cannot distinguish sentinels from real acceptances)', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

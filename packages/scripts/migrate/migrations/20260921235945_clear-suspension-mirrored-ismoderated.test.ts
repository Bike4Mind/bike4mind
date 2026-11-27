import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import migration from './20260921235945_clear-suspension-mirrored-ismoderated';

describe('clear-suspension-mirrored-ismoderated migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
  });

  it('clears isModerated only on suspended users, leaving an admin-set flag on any other status', async () => {
    await migration.up();

    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { 'moderation.status': 'suspended', isModerated: true },
      { $set: { isModerated: false } }
    );
  });
});

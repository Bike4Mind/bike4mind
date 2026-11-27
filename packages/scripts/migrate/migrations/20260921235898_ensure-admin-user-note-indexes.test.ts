import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notes: vi.fn(), revisions: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  AdminUserNoteModel: { createIndexes: mocks.notes },
  AdminUserNoteRevisionModel: { createIndexes: mocks.revisions },
}));
import migration from './20260921235898_ensure-admin-user-note-indexes';

beforeEach(() => vi.clearAllMocks());
describe('admin user note indexes migration', () => {
  it('ensures both collections indexes', async () => {
    await migration.up();
    expect(mocks.notes).toHaveBeenCalledOnce();
    expect(mocks.revisions).toHaveBeenCalledOnce();
  });
  it('leaves retained notes and history untouched on rollback', async () => {
    await migration.down();
    expect(mocks.notes).not.toHaveBeenCalled();
    expect(mocks.revisions).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), cleanup: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ connectDB: vi.fn(), Organization: { find: h.find, updateOne: h.update } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/organizations/retentionCleanup', () => ({ cleanupOrganizationRetention: h.cleanup }));
import { runOrganizationRetention } from './organizationRetention';

beforeEach(() => {
  vi.clearAllMocks();
  const query = {
    sort: vi.fn(),
    limit: vi.fn(),
    maxTimeMS: vi.fn().mockResolvedValue([
      { id: 'a', _id: 'a' },
      { id: 'b', _id: 'b' },
    ]),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  h.find.mockReturnValue(query);
  h.cleanup.mockResolvedValue({});
  h.update.mockResolvedValue({});
});
describe('organization retention schedule', () => {
  it('visits opted-in organizations only and advances their rotation', async () => {
    await runOrganizationRetention();
    expect(h.find).toHaveBeenCalledWith({ personal: false, retentionVersion: { $gt: 0 } });
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
  });
  it('continues after a failed organization and reports failure for the dead-letter path', async () => {
    h.cleanup.mockRejectedValueOnce(new Error('disposable failure'));
    await expect(runOrganizationRetention()).rejects.toThrow('1 organization');
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  find: vi.fn(),
  update: vi.fn(),
  cleanup: vi.fn(),
  fileCleanup: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  PolicyChanged: class extends Error {},
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { error: h.logError, info: h.logInfo } } }));
vi.mock('@bike4mind/database', () => ({ connectDB: vi.fn(), Organization: { find: h.find, updateOne: h.update } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@workers/organizations/retentionCleanup', () => ({
  cleanupOrganizationRetention: h.cleanup,
  RetentionPolicyChangedError: h.PolicyChanged,
}));
vi.mock('@bike4mind/server-utils/utils/generatedFileCleanup', () => ({ retryGeneratedFileCleanup: h.fileCleanup }));
import { runOrganizationRetention, organizationRetentionFilter } from './organizationRetention';
import { registerOrganizationRetention } from '../selfhost/organizationRetention';

beforeEach(() => {
  vi.clearAllMocks();
  h.fileCleanup.mockReset().mockResolvedValue(0);
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
    expect(h.find).toHaveBeenCalledWith(organizationRetentionFilter);
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
  });
  it('continues after a failed organization and reports failure for the dead-letter path', async () => {
    h.cleanup.mockRejectedValueOnce(new Error('disposable failure'));
    await expect(runOrganizationRetention()).rejects.toThrow('1 organization');
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.logError).toHaveBeenCalledWith('Organization retention sweep failed', {
      organizationId: 'a',
      error: expect.objectContaining({ message: 'disposable failure' }),
    });
  });
  it('treats a typed policy change as an expected stop while continuing rotation', async () => {
    h.cleanup.mockRejectedValueOnce(new h.PolicyChanged('changed'));
    await expect(runOrganizationRetention()).resolves.toBeUndefined();
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.logInfo).toHaveBeenCalledWith('Organization retention stopped after a policy change', {
      organizationId: 'a',
    });
  });

  it('drains abandoned generated Files even when no organization opted into a retention policy', async () => {
    h.find.mockReturnValue({ sort: () => ({ limit: () => ({ maxTimeMS: async () => [] }) }) });
    await runOrganizationRetention();
    expect(h.fileCleanup).toHaveBeenCalledWith({ deadline: expect.any(Number) });
    expect(h.cleanup).not.toHaveBeenCalled();
  });
  it('registers the named hourly self-host task and executes the real scheduler callback', async () => {
    type Register = Parameters<typeof registerOrganizationRetention>[0]['registerScheduledTask'];
    const register = vi.fn<Register>();
    registerOrganizationRetention({ registerScheduledTask: register });
    expect(register).toHaveBeenCalledExactlyOnceWith('organizationRetention', 60 * 60_000, expect.any(Function));
    await register.mock.calls[0][2]();
    expect(h.fileCleanup).toHaveBeenCalledOnce();
    expect(h.cleanup).toHaveBeenCalledTimes(2);
  });

  it('reports failed Files receipts while still visiting organizations', async () => {
    h.fileCleanup.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(runOrganizationRetention()).rejects.toThrow('1 generated Files cleanup batch');
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(h.logError).toHaveBeenCalledWith('Generated Files retention cleanup batch failed', {
      error: expect.objectContaining({ message: 'storage unavailable' }),
    });
  });
});

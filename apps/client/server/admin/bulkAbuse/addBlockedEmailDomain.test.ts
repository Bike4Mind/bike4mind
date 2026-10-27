// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { inTransaction: false },
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  recordAdminSettingChange: vi.fn(),
  invalidateSettingsCache: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => Promise<unknown>) => {
    mocks.state.inTransaction = true;
    try {
      return await fn();
    } finally {
      mocks.state.inTransaction = false;
    }
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => ({ lean: () => mocks.findOne(...args) }),
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: mocks.invalidateSettingsCache }));
vi.mock('@server/utils/adminSettingsAudit', () => ({ recordAdminSettingChange: mocks.recordAdminSettingChange }));

import { addBlockedEmailDomain } from './addBlockedEmailDomain';

const req = { user: { id: 'admin-1' } } as unknown as Parameters<typeof addBlockedEmailDomain>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOne.mockResolvedValue({ settingValue: ['old.com'] });
});

describe('addBlockedEmailDomain', () => {
  it('returns false and writes, audits and invalidates nothing when the domain is already listed', async () => {
    const added = await addBlockedEmailDomain(req, '@Old.com');

    expect(added).toBe(false);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.recordAdminSettingChange).not.toHaveBeenCalled();
    expect(mocks.invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('adds the normalized domain, audits inside the transaction, then invalidates the cache after it', async () => {
    const order: string[] = [];
    mocks.recordAdminSettingChange.mockImplementation(async () => {
      order.push(mocks.state.inTransaction ? 'audit-in-tx' : 'audit-outside-tx');
    });
    mocks.invalidateSettingsCache.mockImplementation(() => {
      order.push(mocks.state.inTransaction ? 'invalidate-in-tx' : 'invalidate-after-tx');
    });

    const added = await addBlockedEmailDomain(req, '@Kashre.com');

    expect(added).toBe(true);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'blockedEmailDomains' },
      { $set: { settingValue: ['old.com', 'kashre.com'] } },
      { upsert: true }
    );
    expect(mocks.recordAdminSettingChange).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        settingName: 'blockedEmailDomains',
        before: ['old.com'],
        after: ['old.com', 'kashre.com'],
      })
    );
    expect(order).toEqual(['audit-in-tx', 'invalidate-after-tx']);
    expect(mocks.invalidateSettingsCache).toHaveBeenCalledWith('blockedEmailDomains');
  });

  it('starts a list when the setting does not exist yet', async () => {
    mocks.findOne.mockResolvedValue(null);

    expect(await addBlockedEmailDomain(req, 'kashre.com')).toBe(true);
    expect(mocks.recordAdminSettingChange).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ before: null, after: ['kashre.com'] })
    );
  });

  it('rejects an invalid domain before touching the database', async () => {
    await expect(addBlockedEmailDomain(req, 'not a domain')).rejects.toThrow('Not a valid domain');
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});

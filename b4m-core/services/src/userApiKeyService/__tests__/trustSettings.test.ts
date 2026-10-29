import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAdminSettings, SettingKey } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { loadApiKeyTrustSettings } from '../trust';

const setting = (settingName: SettingKey, settingValue: string): IAdminSettings => ({
  id: settingName,
  createdAt: new Date('2026-10-27T00:00:00Z'),
  updatedAt: new Date('2026-10-27T00:00:00Z'),
  settingName,
  settingValue,
});

describe('loadApiKeyTrustSettings', () => {
  beforeEach(() => invalidateSettingsCache());
  afterEach(() => invalidateSettingsCache());

  const database = (settings: IAdminSettings[]) => ({
    adminSettings: {
      findAll: vi.fn().mockResolvedValue(settings),
      findBySettingNames: vi.fn().mockResolvedValue(settings),
    },
  });

  it('keeps the new quotas disabled when an existing installation has no saved settings', async () => {
    await expect(loadApiKeyTrustSettings(database([]))).resolves.toEqual({
      gateEnabled: true,
      minAccountAgeDays: 7,
      maxActiveKeysUntrusted: 1,
      untrustedRateLimitPerMinute: 20,
      untrustedRequestsPerDay: 0,
      untrustedTokensPerMinute: 0,
      untrustedMaxConcurrent: 0,
    });
  });

  it('maps distinct stored quota values to their admission settings', async () => {
    const db = database([
      setting('apiKeyTrustGateEnabled', 'false'),
      setting('apiKeyMinAccountAgeDays', '14'),
      setting('maxActiveKeysUntrusted', '3'),
      setting('apiKeyUntrustedRateLimitPerMin', '31'),
      setting('apiKeyUntrustedRequestsPerDay', '503'),
      setting('apiKeyUntrustedTokensPerMin', '7001'),
      setting('apiKeyUntrustedMaxConcurrent', '4'),
    ]);
    await expect(loadApiKeyTrustSettings(db)).resolves.toEqual({
      gateEnabled: false,
      minAccountAgeDays: 14,
      maxActiveKeysUntrusted: 3,
      untrustedRateLimitPerMinute: 31,
      untrustedRequestsPerDay: 503,
      untrustedTokensPerMinute: 7001,
      untrustedMaxConcurrent: 4,
    });
  });

  it('propagates a settings read failure rather than turning quotas off', async () => {
    const db = database([]);
    const error = new Error('settings unavailable');
    db.adminSettings.findAll.mockRejectedValue(error);
    db.adminSettings.findBySettingNames.mockRejectedValue(error);
    await expect(loadApiKeyTrustSettings(db)).rejects.toBe(error);
  });
});

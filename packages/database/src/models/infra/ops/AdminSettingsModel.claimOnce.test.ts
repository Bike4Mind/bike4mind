import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSettings, adminSettingsRepository } from './AdminSettingsModel';

describe('AdminSettingsRepository.claimOnce', () => {
  setupMongoTest();

  it('grants the claim to exactly one of many concurrent callers', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => adminSettingsRepository.claimOnce('selfHostBootstrap', `claim-${i}`))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await AdminSettings.countDocuments({ settingName: 'selfHostBootstrap' })).toBe(1);
  });

  it('refuses a second claim once the row exists', async () => {
    expect(await adminSettingsRepository.claimOnce('selfHostBootstrap', 'first')).toBe(true);
    expect(await adminSettingsRepository.claimOnce('selfHostBootstrap', 'second')).toBe(false);
  });

  it('frees the claim only for the claimId that took it', async () => {
    await adminSettingsRepository.claimOnce('selfHostBootstrap', 'owner');

    expect(await adminSettingsRepository.releaseClaim('selfHostBootstrap', 'other')).toBe(false);
    expect(await adminSettingsRepository.claimOnce('selfHostBootstrap', 'next')).toBe(false);

    expect(await adminSettingsRepository.releaseClaim('selfHostBootstrap', 'owner')).toBe(true);
    expect(await adminSettingsRepository.claimOnce('selfHostBootstrap', 'next')).toBe(true);
  });
});

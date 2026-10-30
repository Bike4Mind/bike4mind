import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSettings, adminSettingsRepository } from './AdminSettingsModel';

describe('AdminSettingsRepository.claimOnce', () => {
  setupMongoTest();

  // setupMongoTest drops the database before each test, unique settingName index included, and
  // claimOnce's model.init() only replays the connect-time build. Without this, a build that settled
  // before the drop leaves the concurrent upserts free to insert more than one row.
  beforeEach(async () => {
    await AdminSettings.init();
    await AdminSettings.createIndexes();
  });

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

  it('takes over a stale claim for exactly one caller, and only once it is stale', async () => {
    await adminSettingsRepository.claimOnce('selfHostBootstrap', 'abandoned');
    expect(await adminSettingsRepository.claimOnce('selfHostBootstrap', 'early', 60_000)).toBe(false);

    await AdminSettings.updateOne(
      { settingName: 'selfHostBootstrap' },
      { $set: { 'settingValue.claimedAt': new Date(Date.now() - 120_000) } }
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => adminSettingsRepository.claimOnce('selfHostBootstrap', `retry-${i}`, 60_000))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = `retry-${results.indexOf(true)}`;
    expect(await adminSettingsRepository.releaseClaim('selfHostBootstrap', 'abandoned')).toBe(false);
    expect(await adminSettingsRepository.releaseClaim('selfHostBootstrap', winner)).toBe(true);
  });
});

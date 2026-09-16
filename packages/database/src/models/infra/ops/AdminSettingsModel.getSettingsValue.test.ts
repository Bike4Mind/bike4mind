import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSettings, adminSettingsRepository } from './AdminSettingsModel';

describe('AdminSettingsRepository.getSettingsValue - MaxFileSize coercion (#2456)', () => {
  setupMongoTest();

  // This is the exact call the Slack attachment path (CommandHandler.ts) makes: a cleared
  // field is stored as '', which z.coerce.number() reads as a real 0 unless the schema's
  // `min: 1` rejects it - safeParse then fails and this repository falls back to the
  // setting's own defaultValue (30) instead of returning the coerced 0.
  it('falls back to the default when MaxFileSize is stored as a cleared empty string', async () => {
    await AdminSettings.create({ settingName: 'MaxFileSize', settingValue: '' });
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(30);
  });

  it('returns the configured value when MaxFileSize is set normally', async () => {
    await AdminSettings.create({ settingName: 'MaxFileSize', settingValue: '50' });
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(50);
  });

  it('falls back to the default when no MaxFileSize row exists at all', async () => {
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(30);
  });
});

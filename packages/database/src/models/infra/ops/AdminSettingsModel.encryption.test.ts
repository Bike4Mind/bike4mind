import { describe, it, expect, beforeAll } from 'vitest';
import { configureSecretsAtRest, encryptSecret, generateEncryptionKey, isEncrypted } from '@bike4mind/utils';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSettings, adminSettingsRepository } from './AdminSettingsModel';

const KEY = generateEncryptionKey();

describe('AdminSettingsRepository decrypt-on-read', () => {
  setupMongoTest();

  beforeAll(() => {
    configureSecretsAtRest(KEY);
  });

  it('returns decrypted plaintext for a sensitive setting stored as ciphertext', async () => {
    const plaintext = 'sk-ant-api03-super-secret';
    await AdminSettings.create({ settingName: 'anthropicDemoKey', settingValue: encryptSecret(plaintext, KEY) });

    const byName = await adminSettingsRepository.findBySettingName('anthropicDemoKey');
    expect(byName?.settingValue).toBe(plaintext);

    const byNames = await adminSettingsRepository.findBySettingNames(['anthropicDemoKey']);
    expect(byNames[0]?.settingValue).toBe(plaintext);

    const all = await adminSettingsRepository.findAll();
    expect(all.find(s => s.settingName === 'anthropicDemoKey')?.settingValue).toBe(plaintext);
  });

  it('leaves a not-yet-migrated plaintext sensitive value unchanged', async () => {
    await AdminSettings.create({ settingName: 'openaiDemoKey', settingValue: 'sk-plaintext-legacy' });
    const setting = await adminSettingsRepository.findBySettingName('openaiDemoKey');
    expect(setting?.settingValue).toBe('sk-plaintext-legacy');
  });

  it('does not touch a non-sensitive setting value', async () => {
    // A non-sensitive value that happens to be a plain string is returned verbatim.
    await AdminSettings.create({ settingName: 'tagLineMain', settingValue: 'Welcome aboard' });
    const setting = await adminSettingsRepository.findBySettingName('tagLineMain');
    expect(setting?.settingValue).toBe('Welcome aboard');
  });

  it('stores sensitive values as ciphertext (raw model read is not plaintext)', async () => {
    const plaintext = 'sk-live-should-be-encrypted';
    await AdminSettings.create({ settingName: 'geminiDemoKey', settingValue: encryptSecret(plaintext, KEY) });
    const raw = await AdminSettings.findOne({ settingName: 'geminiDemoKey' }).lean();
    expect(typeof raw?.settingValue).toBe('string');
    expect(isEncrypted(raw?.settingValue as string)).toBe(true);
    expect(raw?.settingValue).not.toBe(plaintext);
  });
});

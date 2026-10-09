import { describe, it, expect, beforeAll } from 'vitest';
import { configureSecretsAtRest, encryptSecret, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
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

describe('AdminSettingsSchema toJSON/toObject chokepoint', () => {
  setupMongoTest();

  beforeAll(() => {
    configureSecretsAtRest(KEY);
  });

  // Acceptance criterion for #1606: a hydrated document serialised via toJSON()
  // must return a masked value, not plaintext and not raw ciphertext. This pins the
  // chokepoint without per-caller co-operation -- any code path that does
  // AdminSettings.find() + res.json() or JSON.stringify() is automatically safe.
  it('toJSON() masks a sensitive settingValue without requiring per-caller redaction', async () => {
    const plaintext = 'sk-chokepoint-test-key-12345';
    const ciphertext = encryptSecret(plaintext, KEY);
    await AdminSettings.create({ settingName: 'anthropicDemoKey', settingValue: ciphertext });

    const doc = await AdminSettings.findOne({ settingName: 'anthropicDemoKey' });
    const serialised = doc!.toJSON();

    expect(serialised.settingValue).not.toBe(plaintext);
    expect(serialised.settingValue).not.toBe(ciphertext);
    expect(typeof serialised.settingValue).toBe('string');
    expect(serialised.settingValue as string).toMatch(/^\*+/);
  });

  it('toObject() masks a sensitive settingValue', async () => {
    const plaintext = 'sk-toobject-test-key-99999';
    const ciphertext = encryptSecret(plaintext, KEY);
    await AdminSettings.create({ settingName: 'openaiDemoKey', settingValue: ciphertext });

    const doc = await AdminSettings.findOne({ settingName: 'openaiDemoKey' });
    const obj = doc!.toObject();

    expect(obj.settingValue).not.toBe(plaintext);
    expect(obj.settingValue).not.toBe(ciphertext);
    expect(obj.settingValue as string).toMatch(/^\*+/);
  });

  it('trusted lean reads still return plaintext after decryptSettingInPlace', async () => {
    const plaintext = 'sk-lean-trusted-path-55555';
    const ciphertext = encryptSecret(plaintext, KEY);
    await AdminSettings.create({ settingName: 'groqDemoKey', settingValue: ciphertext });

    // .lean() bypasses the toJSON transform; decryptSettingInPlace then gives plaintext.
    const byName = await adminSettingsRepository.findBySettingName('groqDemoKey');
    expect(byName?.settingValue).toBe(plaintext);

    const byNames = await adminSettingsRepository.findBySettingNames(['groqDemoKey']);
    expect(byNames[0]?.settingValue).toBe(plaintext);

    const all = await adminSettingsRepository.findAll();
    expect(all.find(s => s.settingName === 'groqDemoKey')?.settingValue).toBe(plaintext);
  });

  // findAllByTag cannot be end-to-end tested here: 'tags' is not in AdminSettingsSchema,
  // so Mongoose drops it on create and the query always returns []. Adding the field is a
  // separate schema change outside the scope of this chokepoint PR. The method itself uses
  // the same .lean({ virtuals: true }) + decryptSettingInPlace path as findBySettingNames
  // and findAll, which are both covered above.

  it('getSettingsValue returns plaintext for a sensitive setting', async () => {
    const plaintext = 'sk-getsettingsvalue-test-88888';
    const ciphertext = encryptSecret(plaintext, KEY);
    await AdminSettings.create({ settingName: 'anthropicDemoKey', settingValue: ciphertext });

    const result = await adminSettingsRepository.getSettingsValue('anthropicDemoKey');
    expect(result).toBe(plaintext);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  allSettingDefinitions,
  API_SERVICE_GROUPS,
  experimentalFeatureSettingKeys,
  getExperimentalFeatureSettingKeys,
  isRegisteredSettingKey,
  makeContributedBooleanSetting,
  makeContributedNumberSetting,
  makeContributedStringSetting,
  publicSafeSettingKeys,
  redactSettingSecrets,
  registerContributedSettings,
  resetContributedSettings,
  resolveSettingDefinition,
  settingsMap,
  userReadableSettingKeys,
  type AdminSettingDoc,
} from './settings';

const flag = makeContributedBooleanSetting({
  key: 'ExtensionFlag',
  name: 'Extension flag',
  description: 'A contributed boolean',
  defaultValue: false,
  group: API_SERVICE_GROUPS.EXPERIMENTAL.id,
});

const limit = makeContributedNumberSetting({
  key: 'extensionLimit',
  name: 'Extension limit',
  description: 'A contributed number',
  defaultValue: 7,
  min: 1,
  max: 10,
  int: true,
  userReadable: true,
});

const token = makeContributedStringSetting({
  key: 'extensionToken',
  name: 'Extension token',
  description: 'A contributed secret',
  defaultValue: undefined,
  isSensitive: true,
  publicSafe: true,
});

afterEach(() => resetContributedSettings());

describe('registerContributedSettings', () => {
  it('registers definitions that then resolve by key', () => {
    expect(registerContributedSettings([flag, limit])).toEqual({
      registered: ['ExtensionFlag', 'extensionLimit'],
      coreCollisions: [],
      duplicates: [],
      rejected: [],
    });
    expect(resolveSettingDefinition('ExtensionFlag')).toBe(flag);
    expect(isRegisteredSettingKey('extensionLimit')).toBe(true);
    expect(allSettingDefinitions().map(s => s.key)).toEqual(
      expect.arrayContaining(['ExtensionFlag', 'extensionLimit'])
    );
  });

  it('applies the factory defaults and validation to a contributed definition', () => {
    registerContributedSettings([flag, limit]);
    const limitDef = resolveSettingDefinition('extensionLimit')!;
    expect(limitDef.schema.parse(undefined)).toBe(7);
    expect(limitDef.schema.parse('')).toBe(7);
    expect(limitDef.schema.parse('3')).toBe(3);
    expect(limitDef.schema.safeParse(11).success).toBe(false);
    expect(limitDef.schema.safeParse(2.5).success).toBe(false);
    expect(resolveSettingDefinition('ExtensionFlag')!.schema.parse('true')).toBe(true);
  });

  it('keeps the core definition when a contribution reuses a core key', () => {
    const clash = makeContributedBooleanSetting({ key: 'lowCreditsThreshold', name: 'x', description: 'x' });
    const core = resolveSettingDefinition('lowCreditsThreshold');
    expect(registerContributedSettings([clash]).coreCollisions).toEqual(['lowCreditsThreshold']);
    expect(resolveSettingDefinition('lowCreditsThreshold')).toBe(core);
  });

  it('keeps the first contribution of a key and ignores a repeat of the same definition', () => {
    const second = makeContributedBooleanSetting({ key: 'ExtensionFlag', name: 'Second', description: 'x' });
    registerContributedSettings([flag]);
    expect(registerContributedSettings([flag]).duplicates).toEqual([]);
    expect(registerContributedSettings([second]).duplicates).toEqual(['ExtensionFlag']);
    expect(resolveSettingDefinition('ExtensionFlag')).toBe(flag);
  });

  it('rejects a sensitive definition that carries a default, since the module reaches the client', () => {
    const seeded = makeContributedStringSetting({
      key: 'seededToken',
      name: 'x',
      description: 'x',
      defaultValue: 'not-a-secret-but-shipped',
      isSensitive: true,
    });
    expect(registerContributedSettings([seeded, token]).rejected).toEqual(['seededToken']);
    expect(isRegisteredSettingKey('seededToken')).toBe(false);
    expect(isRegisteredSettingKey('extensionToken')).toBe(true);
  });

  it('rejects a reserved object key, a blank key and a definition without a schema', () => {
    const noSchema = { ...flag, key: 'noSchema', schema: undefined } as unknown as typeof flag;
    const reserved = makeContributedBooleanSetting({ key: '__proto__', name: 'x', description: 'x' });
    const blank = makeContributedBooleanSetting({ key: ' ', name: 'x', description: 'x' });
    expect(registerContributedSettings([noSchema, reserved, blank]).rejected).toEqual(['noSchema', '__proto__', ' ']);
    expect(allSettingDefinitions()).toHaveLength(Object.keys(settingsMap).length);
  });
});

describe('settings helpers over contributed definitions', () => {
  it('surfaces a contributed experimental flag only through the function form', () => {
    registerContributedSettings([flag]);
    expect(getExperimentalFeatureSettingKeys()).toContain('ExtensionFlag');
    expect(experimentalFeatureSettingKeys).not.toContain('ExtensionFlag');
    expect(userReadableSettingKeys()).not.toContain('ExtensionFlag');
  });

  it('applies userReadable, publicSafe and isSensitive to contributed keys', () => {
    registerContributedSettings([limit, token]);
    expect(userReadableSettingKeys()).toContain('extensionLimit');
    expect(publicSafeSettingKeys()).toContain('extensionToken');
    expect(userReadableSettingKeys()).not.toContain('extensionToken');
  });

  it('keeps a contributed setting from non-admins unless it opts in and is not sensitive', () => {
    const plain = makeContributedBooleanSetting({ key: 'extensionPlain', name: 'x', description: 'x' });
    const experimentalSecret = makeContributedStringSetting({
      key: 'extensionExperimentalSecret',
      name: 'x',
      description: 'x',
      defaultValue: undefined,
      isSensitive: true,
      group: API_SERVICE_GROUPS.EXPERIMENTAL.id,
    });
    const experimentalFlag = makeContributedBooleanSetting({
      key: 'extensionExperimentalFlag',
      name: 'x',
      description: 'x',
      group: API_SERVICE_GROUPS.EXPERIMENTAL.id,
    });
    const experimentalOptIn = makeContributedBooleanSetting({
      key: 'extensionExperimentalOptIn',
      name: 'x',
      description: 'x',
      group: API_SERVICE_GROUPS.EXPERIMENTAL.id,
      userReadable: true,
    });
    registerContributedSettings([plain, experimentalSecret, experimentalFlag, experimentalOptIn]);
    expect(userReadableSettingKeys()).not.toContain('extensionExperimentalFlag');
    expect(userReadableSettingKeys()).toContain('extensionExperimentalOptIn');
    expect(getExperimentalFeatureSettingKeys()).toContain('extensionExperimentalSecret');
    expect(userReadableSettingKeys()).not.toContain('extensionExperimentalSecret');
    expect(userReadableSettingKeys()).not.toContain('extensionPlain');
  });

  it('masks a sensitive contributed value and passes a plain one through', () => {
    registerContributedSettings([limit, token]);
    const doc = (settingName: string, settingValue: unknown) => ({ settingName, settingValue }) as AdminSettingDoc;
    expect(redactSettingSecrets(doc('extensionToken', 'secret-value-1234')).settingValue).not.toBe('secret-value-1234');
    expect(redactSettingSecrets(doc('extensionLimit', 5)).settingValue).toBe(5);
  });

  it('masks a key that is no longer registered', () => {
    const doc = { settingName: 'extensionLimit', settingValue: 'plain-but-unknown' } as AdminSettingDoc;
    expect(redactSettingSecrets(doc).settingValue).not.toBe('plain-but-unknown');
  });

  it('rejects a definition that declares a scope', () => {
    const scoped = { ...flag, key: 'scopedFlag', scope: { settableAt: ['org'] } } as unknown as typeof flag;
    expect(registerContributedSettings([scoped]).rejected).toEqual(['scopedFlag']);
    expect(isRegisteredSettingKey('scopedFlag')).toBe(false);
  });
});

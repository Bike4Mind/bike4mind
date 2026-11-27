import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { adminSettingsRepository } from '@bike4mind/database/infra';
import { z } from 'zod';
import {
  makeContributedBooleanSetting,
  makeContributedNumberSetting,
  makeContributedObjectSetting,
  makeContributedStringSetting,
  NESTED_SECRET_PLACEHOLDER,
  registerContributedSettings,
} from '@bike4mind/common';
import { decryptSecret } from '@bike4mind/server-utils/security/secretEncryption';
import { getContributedSettingValue } from '@bike4mind/utils';
import { configureSecretsAtRest } from '@bike4mind/utils/security';

/**
 * A contributed setting through the real write and read paths: update stores it, fetch lists it,
 * and getContributedSettingValue parses what was stored. An unregistered key is still refused.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use() {
      return this;
    },
    put: (handler: (...a: unknown[]) => unknown) => handler,
    get: (handler: (...a: unknown[]) => unknown) => handler,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
// The in-memory server is standalone, so it cannot run the write's transaction; the audit entry
// is covered in update.test.ts.
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  withTransaction: (fn: () => unknown) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'a'.repeat(64) } }));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  materializePublicSettingsArtifactSafe: vi.fn(() => Promise.resolve()),
  ensurePublicSettingsArtifactOncePerInstance: vi.fn(() => Promise.resolve()),
}));

import updateHandler from '../update';
import fetchHandler from '../fetch';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

registerContributedSettings([
  makeContributedBooleanSetting({
    key: 'ExtensionFlag',
    name: 'Extension flag',
    description: 'x',
    defaultValue: false,
  }),
  makeContributedNumberSetting({
    key: 'extensionLimit',
    name: 'Extension limit',
    description: 'x',
    defaultValue: 7,
    max: 10,
  }),
  makeContributedStringSetting({
    key: 'extensionToken',
    name: 'Extension token',
    description: 'x',
    defaultValue: undefined,
    isSensitive: true,
  }),
  makeContributedObjectSetting({
    key: 'extensionTargets',
    name: 'Extension targets',
    description: 'x',
    schema: z.object({
      targets: z.array(z.object({ id: z.string(), label: z.string().default(''), token: z.string().default('') })),
    }),
    nestedSecrets: [{ arrayKey: 'targets', identityFields: ['id'], secretFields: ['token'] }],
  }),
]);

type Targets = { targets: Array<{ id: string; label: string; token: string }> };
const storedTargets = async () => {
  const raw = await mongoose.connection.collection('adminsettings').findOne({ settingName: 'extensionTargets' });
  return (raw?.settingValue as Targets).targets;
};

const put = async (key: string, value: unknown) => {
  const json = vi.fn((x: unknown) => x);
  const req = {
    user: { isAdmin: true },
    ability: { can: () => true },
    body: { key, value },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  await (updateHandler as unknown as Handler)(req, { json });
  return json;
};

const fetchAll = async () => {
  const json = vi.fn((x: unknown) => x);
  const req = { user: { isAdmin: true }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  await (fetchHandler as unknown as Handler)(req, { json });
  return json.mock.calls[0][0] as Array<{ settingName: string; settingValue: unknown }>;
};

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  // The same key the mocked Config hands update.ts, so the repository can decrypt what the route wrote.
  configureSecretsAtRest('a'.repeat(64));
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('settings/update with contributed settings (real Mongo)', () => {
  it('stores, lists and resolves a contributed boolean and number', async () => {
    await put('ExtensionFlag', 'true');
    await put('extensionLimit', '4');
    expect((await adminSettingsRepository.findBySettingName('ExtensionFlag'))?.settingValue).toBe(true);
    expect((await adminSettingsRepository.findBySettingName('extensionLimit'))?.settingValue).toBe(4);

    const listed = await fetchAll();
    const values = Object.fromEntries(listed.map(s => [s.settingName, String(s.settingValue)]));
    expect(getContributedSettingValue('ExtensionFlag', values)).toBe(true);
    expect(getContributedSettingValue('extensionLimit', values)).toBe(4);
  });

  it('encrypts a sensitive contributed value at rest and decrypts it on a trusted read', async () => {
    await put('extensionToken', 'plain-secret-value-1234');
    const raw = await mongoose.connection.collection('adminsettings').findOne({ settingName: 'extensionToken' });
    expect(raw?.settingValue).toEqual(expect.any(String));
    expect(raw?.settingValue).not.toBe('plain-secret-value-1234');
    expect((await adminSettingsRepository.findBySettingName('extensionToken'))?.settingValue).toBe(
      'plain-secret-value-1234'
    );
  });

  it('encrypts a nested secret field at rest and answers with it masked', async () => {
    const json = await put('extensionTargets', {
      targets: [
        { id: 'a', token: 'plain-token-a' },
        { id: 'b', token: '' },
      ],
    });

    const [a, b] = await storedTargets();
    expect(a.token).not.toBe('plain-token-a');
    expect(decryptSecret(a.token, 'a'.repeat(64))).toBe('plain-token-a');
    expect(b.token).toBe('');

    const answered = json.mock.calls[0][0] as { settingValue: Targets };
    expect(answered.settingValue.targets.map(t => t.token)).toEqual([NESTED_SECRET_PLACEHOLDER, '']);
    expect(JSON.stringify(answered)).not.toContain(a.token);

    const listed = (await fetchAll()).find(s => s.settingName === 'extensionTargets');
    expect((listed?.settingValue as Targets).targets.map(t => t.token)).toEqual([NESTED_SECRET_PLACEHOLDER, '']);
  });

  it('keeps the stored secret of the same item when the mask comes back, whatever the order', async () => {
    const [before] = await storedTargets();
    await put('extensionTargets', {
      targets: [
        { id: 'c', token: 'plain-token-c' },
        { id: 'a', label: 'renamed', token: NESTED_SECRET_PLACEHOLDER },
        { id: 'd', token: NESTED_SECRET_PLACEHOLDER },
      ],
    });

    const [c, a, d] = await storedTargets();
    expect(a).toEqual({ id: 'a', label: 'renamed', token: before.token });
    expect(decryptSecret(c.token, 'a'.repeat(64))).toBe('plain-token-c');
    // A mask with nothing stored behind it clears the field rather than storing the mask.
    expect(d.token).toBe('');
  });

  it('validates a contributed value with its own schema', async () => {
    await expect(put('extensionLimit', '11')).rejects.toThrow();
    expect((await adminSettingsRepository.findBySettingName('extensionLimit'))?.settingValue).toBe(4);
  });

  it('still refuses a key nobody registered', async () => {
    await expect(put('notARegisteredKey', 'true')).rejects.toThrow();
    expect(await adminSettingsRepository.findBySettingName('notARegisteredKey')).toBeNull();
  });
});

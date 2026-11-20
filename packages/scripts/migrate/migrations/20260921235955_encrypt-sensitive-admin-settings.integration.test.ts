import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  makeContributedStringSetting,
  registerContributedSettings,
  resetContributedSettings,
  SENSITIVE_SETTING_MASK,
} from '@bike4mind/common';
import {
  configureSecretsAtRest,
  decryptAtRest,
  encryptSecret,
  generateEncryptionKey,
  isEncrypted,
} from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import { AdminSettings } from '@bike4mind/database';
import migration from './20260921235955_encrypt-sensitive-admin-settings';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;
const KEY = generateEncryptionKey();

const adminsettings = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('adminsettings');
};

const valueOf = async (settingName: string) =>
  (await adminsettings().findOne({ settingName }))?.settingValue as unknown;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  configureSecretsAtRest(KEY);
  await adminsettings().deleteMany({});
});

describe('encrypt sensitive admin settings', () => {
  it('encrypts plaintext sensitive rows and leaves everything else untouched', async () => {
    const alreadyEncrypted = encryptSecret('sk-already', KEY);
    await adminsettings().insertMany([
      { settingName: 'FirecrawlApiKey', settingValue: 'fc-plaintext' },
      { settingName: 'githubMcpClientSecret', settingValue: 'gh-plaintext' },
      { settingName: 'openaiDemoKey', settingValue: alreadyEncrypted },
      { settingName: 'geminiDemoKey', settingValue: `${SENSITIVE_SETTING_MASK}1234` },
      { settingName: 'xaiDemoKey', settingValue: '' },
      { settingName: 'tagLineMain', settingValue: 'Welcome aboard' },
      { settingName: 'sreAgentConfig', settingValue: { repos: [] } },
      { settingName: 'notARegisteredSetting', settingValue: 'leave-me' },
    ]);

    await migration.up();

    const firecrawl = (await valueOf('FirecrawlApiKey')) as string;
    const github = (await valueOf('githubMcpClientSecret')) as string;
    expect(isEncrypted(firecrawl)).toBe(true);
    expect(isEncrypted(github)).toBe(true);
    expect(decryptAtRest(firecrawl)).toBe('fc-plaintext');
    expect(decryptAtRest(github)).toBe('gh-plaintext');

    expect(await valueOf('openaiDemoKey')).toBe(alreadyEncrypted);
    expect(await valueOf('geminiDemoKey')).toBe(`${SENSITIVE_SETTING_MASK}1234`);
    expect(await valueOf('xaiDemoKey')).toBe('');
    expect(await valueOf('tagLineMain')).toBe('Welcome aboard');
    expect(await valueOf('sreAgentConfig')).toEqual({ repos: [] });
    expect(await valueOf('notARegisteredSetting')).toBe('leave-me');
  });

  it('is idempotent: a second run does not re-encrypt ciphertext', async () => {
    await adminsettings().insertOne({ settingName: 'SerperKey', settingValue: 'serper-plaintext' });
    await migration.up();
    const once = await valueOf('SerperKey');
    await migration.up();
    expect(await valueOf('SerperKey')).toBe(once);
    expect(decryptAtRest(once as string)).toBe('serper-plaintext');
  });

  it('throws, leaving rows untouched, when plaintext exists but no key is configured', async () => {
    await adminsettings().insertOne({ settingName: 'FirecrawlApiKey', settingValue: 'fc-plaintext' });
    configureSecretsAtRest(undefined);
    await expect(migration.up()).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);
    expect(await valueOf('FirecrawlApiKey')).toBe('fc-plaintext');
  });

  it('returns without a key when there is nothing to encrypt', async () => {
    await adminsettings().insertOne({ settingName: 'tagLineMain', settingValue: 'Welcome aboard' });
    configureSecretsAtRest(undefined);
    await expect(migration.up()).resolves.toBeUndefined();
  });

  it('encrypts soft-deleted rows', async () => {
    await adminsettings().insertOne({
      settingName: 'SerperKey',
      settingValue: 'serper-plaintext',
      deletedAt: new Date(),
    });
    await migration.up();
    expect(decryptAtRest((await valueOf('SerperKey')) as string)).toBe('serper-plaintext');
  });

  it('leaves a non-string value on a sensitive key untouched', async () => {
    await adminsettings().insertOne({ settingName: 'SerperKey', settingValue: { x: 1 } });
    await expect(migration.up()).resolves.toBeUndefined();
    expect(await valueOf('SerperKey')).toEqual({ x: 1 });
  });

  it('does not overwrite a value saved between the read and the update', async () => {
    await adminsettings().insertOne({ settingName: 'FirecrawlApiKey', settingValue: 'fc-plaintext' });
    const saved = encryptSecret('fc-from-admin', KEY);
    const realUpdateOne = AdminSettings.collection.updateOne.bind(AdminSettings.collection);
    const spy = vi.spyOn(AdminSettings.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      await adminsettings().updateOne({ settingName: 'FirecrawlApiKey' }, { $set: { settingValue: saved } });
      return realUpdateOne(...args);
    });
    await migration.up();
    spy.mockRestore();
    expect(await valueOf('FirecrawlApiKey')).toBe(saved);
  });

  describe('contributed settings', () => {
    afterEach(() => resetContributedSettings());

    it('encrypts a contributed sensitive setting', async () => {
      registerContributedSettings([
        makeContributedStringSetting({
          key: 'contributedTestSecret',
          name: 'Contributed test secret',
          defaultValue: undefined,
          isSensitive: true,
        } as Parameters<typeof makeContributedStringSetting>[0]),
      ]);
      await adminsettings().insertOne({ settingName: 'contributedTestSecret', settingValue: 'contrib-plaintext' });
      await migration.up();
      expect(decryptAtRest((await valueOf('contributedTestSecret')) as string)).toBe('contrib-plaintext');
    });
  });
});

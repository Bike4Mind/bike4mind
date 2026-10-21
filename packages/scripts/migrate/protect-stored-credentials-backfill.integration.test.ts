import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ApiKey, McpServer, SlackDevWorkspace, User, SecretRotation } from '@bike4mind/database';
import {
  configureSecretsAtRest,
  decryptAtRest,
  encryptSecret,
  generateEncryptionKey,
  isEncrypted,
} from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { protectStoredCredentials } from './protect-stored-credentials-backfill';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const encryptionKey = generateEncryptionKey();
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  configureSecretsAtRest(encryptionKey);
  vi.stubEnv('MEMORY_KEY_SECRET', 'persistent-test-memory-master');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('credential backfill', () => {
  it('protects legacy rows without changing their secrets, and is idempotent', async () => {
    const provider = await ApiKey.collection.insertOne({
      userId: 'owner',
      apiKey: encryptSecret('provider-canary', encryptionKey),
    });
    const mcp = await McpServer.collection.insertOne({
      userId: 'owner',
      name: 'notion',
      envVariables: [{ key: 'TOKEN', value: 'mcp-canary' }],
    });
    const slack = await SlackDevWorkspace.collection.insertOne({
      slackAppId: 'app',
      slackClientSecret: 'slack-canary',
    });
    const user = await User.collection.insertOne({
      securityQuestions: [{ question: 'First pet?', answer: 'answer-canary' }],
    });
    const rotation = await SecretRotation.collection.insertOne({
      keyName: 'JWT_SECRET',
      previousKey: 'jwt-canary',
      rotatedAt: new Date(Date.now() - 25 * 3600000),
    });
    const keys = mongoose.connection.collection('memoryprincipalkeys');
    const key = await keys.insertOne({
      principalKind: 'user',
      principalId: 'owner',
      dek: 'raw:' + Buffer.alloc(32, 7).toString('base64'),
    });
    await protectStoredCredentials();
    const apiRow = await ApiKey.collection.findOne({ _id: provider.insertedId });
    const mcpRow = await McpServer.collection.findOne({ _id: mcp.insertedId });
    expect(apiRow!.apiKey.startsWith('v2:')).toBe(true);
    expect(
      decryptAtRest(apiRow!.apiKey, JSON.stringify(['ApiKey', 'owner', String(provider.insertedId), 'apiKey']))
    ).toBe('provider-canary');
    expect(
      decryptAtRest(mcpRow!.envVariables[0].value, JSON.stringify(['mcp', 'owner', String(mcp.insertedId), 'TOKEN']))
    ).toBe('mcp-canary');
    expect(
      isEncrypted((await SlackDevWorkspace.collection.findOne({ _id: slack.insertedId }))!.slackClientSecret!)
    ).toBe(true);
    const questions = (await User.collection.findOne({ _id: user.insertedId }))!.securityQuestions!;
    expect(await bcrypt.compare('answer-canary', questions[0].answer)).toBe(true);
    const rotated = await SecretRotation.collection.findOne({ _id: rotation.insertedId });
    expect(rotated).not.toHaveProperty('previousKey');
    expect(rotated!.capturedKeyFingerprint).toHaveLength(64);
    const wrapped = (await keys.findOne({ _id: key.insertedId }))!.dek;
    expect(wrapped).toMatch(/^enc:/);
    await protectStoredCredentials();
    expect((await ApiKey.collection.findOne({ _id: provider.insertedId }))!.apiKey).toBe(apiRow!.apiKey);
    expect((await keys.findOne({ _id: key.insertedId }))!.dek).toBe(wrapped);
  });
  it('fails before writing and existing values untouched when the master key is missing', async () => {
    vi.stubEnv('MEMORY_KEY_SECRET', 'not-configured');
    const row = await ApiKey.collection.insertOne({ userId: 'owner', apiKey: 'provider-canary' });
    await expect(protectStoredCredentials()).rejects.toThrow('MEMORY_KEY_SECRET');
    expect((await ApiKey.collection.findOne({ _id: row.insertedId }))!.apiKey).toBe('provider-canary');
  });

  it('names an undecryptable row and still converts the later phases', async () => {
    // Format-valid but encrypted under a key nobody holds: a rerun can never convert it, so the
    // run must say WHICH row is stuck rather than dying on an anonymous message, and it must not
    // leave the other collections un-migrated because of it.
    const stuck = await ApiKey.collection.insertOne({
      userId: 'owner',
      apiKey: `${'11'.repeat(16)}:${'22'.repeat(16)}:${'33'.repeat(8)}`,
    });
    const stuckMcp = await McpServer.collection.insertOne({
      userId: 'owner',
      name: 'stuck',
      envVariables: [{ key: 'API_TOKEN', value: `${'44'.repeat(16)}:${'55'.repeat(16)}:${'66'.repeat(8)}` }],
    });
    const stuckRotation = await SecretRotation.collection.insertOne({
      keyName: 'JWT_SECRET',
      previousKey: `${'77'.repeat(16)}:${'88'.repeat(16)}:${'99'.repeat(8)}`,
      rotatedAt: new Date(),
      nextRotation: new Date(),
      rotationIntervalDays: 30,
    });
    const mcp = await McpServer.collection.insertOne({
      userId: 'owner',
      name: 'notion',
      envVariables: [{ key: 'TOKEN', value: 'mcp-canary' }],
    });

    const failure = await protectStoredCredentials().catch((error: Error) => error);

    // Every stuck row is named in the one summary, across collections and fields.
    expect((failure as Error).message).toContain(`ApiKey/${stuck.insertedId}.apiKey`);
    expect((failure as Error).message).toContain(`McpServer/${stuckMcp.insertedId}.API_TOKEN`);
    expect((failure as Error).message).toContain(`SecretRotation/${stuckRotation.insertedId}.previousKey`);

    const mcpRow = await McpServer.collection.findOne({ _id: mcp.insertedId });
    expect(mcpRow!.envVariables[0].value.startsWith('v2:')).toBe(true);
  });
});

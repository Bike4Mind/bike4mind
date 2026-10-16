import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { MCP_OAUTH_PENDING_TTL_SECONDS } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { McpOAuthPending, mcpOAuthPendingRepository } from './McpOAuthPendingModel';

const pending = (stateHash = 'state-hash-1') => ({
  stateHash,
  userId: 'user-1',
  connectionId: 'conn-1',
  codeVerifierEnc: 'enc:verifier',
  redirectUri: 'https://app.example.com/api/mcp-connections/oauth/callback',
  issuer: 'https://auth.example.com',
  resource: 'https://mcp.example.com/mcp',
  scopes: ['read'],
});

describe('McpOAuthPendingModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await McpOAuthPending.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await McpOAuthPending.deleteMany({});
  });

  it('has a unique stateHash and a 600s TTL on createdAt', async () => {
    const indexes = await McpOAuthPending.collection.indexes();
    expect(indexes.find(i => i.key.stateHash === 1)).toMatchObject({ unique: true });
    expect(indexes.find(i => i.name === 'mcpoauthpending_ttl')).toMatchObject({
      key: { createdAt: 1 },
      expireAfterSeconds: MCP_OAUTH_PENDING_TTL_SECONDS,
    });
    expect(MCP_OAUTH_PENDING_TTL_SECONDS).toBe(600);
  });

  it('does not return the code verifier from create or default reads', async () => {
    const created = await mcpOAuthPendingRepository.create(pending());
    expect(created).not.toHaveProperty('codeVerifierEnc');
    expect(await mcpOAuthPendingRepository.findById(created.id)).not.toHaveProperty('codeVerifierEnc');
  });

  it('consumes a state exactly once, returning the verifier', async () => {
    await mcpOAuthPendingRepository.create(pending());

    const first = await mcpOAuthPendingRepository.consume('state-hash-1');
    expect(first?.codeVerifierEnc).toBe('enc:verifier');
    expect(first?.consumedAt).toBeInstanceOf(Date);

    expect(await mcpOAuthPendingRepository.consume('state-hash-1')).toBeNull();
  });

  it('lets only one of several concurrent callbacks consume the state', async () => {
    await mcpOAuthPendingRepository.create(pending());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => mcpOAuthPendingRepository.consume('state-hash-1'))
    );
    expect(results.filter(r => r !== null)).toHaveLength(1);
  });

  it('refuses an unknown or expired state', async () => {
    expect(await mcpOAuthPendingRepository.consume('nope')).toBeNull();

    const created = await mcpOAuthPendingRepository.create(pending('old'));
    await McpOAuthPending.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $set: { createdAt: new Date(Date.now() - (MCP_OAUTH_PENDING_TTL_SECONDS + 5) * 1000) } }
    );
    expect(await mcpOAuthPendingRepository.consume('old')).toBeNull();
  });
});

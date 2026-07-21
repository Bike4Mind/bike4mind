import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey } from '../UserApiKeyModel';
import { ApiKeyScope } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UserApiKey.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
});

const base = {
  userId: 'u1',
  name: 'k',
  keyHash: '$2b$12$abcdefghijklmnopqrstuv',
  scopes: [ApiKeyScope.EMBED_CHAT],
  metadata: { createdFrom: 'dashboard' as const },
};

describe('UserApiKeyModel embed fields (round-trip)', () => {
  it('persists agentId / allowedOrigins / branding and strips keyHash in toJSON', async () => {
    const created = await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_embed01',
      agentId: 'agent-42',
      allowedOrigins: ['https://example.com', 'https://widgets.example.org'],
      branding: { displayName: 'Acme', primaryColor: '#0a7', hideBranding: true },
    });

    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.agentId).toBe('agent-42');
    expect(loaded?.allowedOrigins).toEqual(['https://example.com', 'https://widgets.example.org']);
    expect(loaded?.branding?.displayName).toBe('Acme');
    expect(loaded?.branding?.hideBranding).toBe(true);

    const json = loaded!.toJSON() as Record<string, unknown>;
    expect(json.keyHash).toBeUndefined();
    expect(json.keyPrefix).toBe('b4m_live_embed01');
  });

  it('does not materialize empty allowedOrigins / branding / spendCap on a non-embed key', async () => {
    const created = await UserApiKey.create({
      ...base,
      scopes: [ApiKeyScope.AI_CHAT],
      keyPrefix: 'b4m_live_plain001',
    });
    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.agentId).toBeUndefined();
    expect(loaded?.allowedOrigins).toBeUndefined();
    expect(loaded?.branding).toBeUndefined();
    expect(loaded?.spendCap).toBeUndefined();
  });

  it('persists spendCap on an embed key', async () => {
    const created = await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_capped01',
      agentId: 'agent-42',
      spendCap: 5000,
    });
    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.spendCap).toBe(5000);
  });

  it('persists spendCap: 0 distinctly from an absent cap', async () => {
    const created = await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_capzero1',
      agentId: 'agent-42',
      spendCap: 0,
    });
    const loaded = await UserApiKey.findById(created.id);
    // 0 must survive as a real value - a `default: undefined` field that clobbered
    // 0 would silently turn "block all spend" into "uncapped".
    expect(loaded?.spendCap).toBe(0);
    expect(loaded?.spendCap).not.toBeUndefined();
  });

  it('builds the sparse { agentId, status } compound index', async () => {
    const indexes = await UserApiKey.collection.getIndexes();
    const hasAgentIndex = Object.values(indexes).some(
      (spec: unknown) =>
        JSON.stringify(spec) ===
        JSON.stringify([
          ['agentId', 1],
          ['status', 1],
        ])
    );
    expect(hasAgentIndex).toBe(true);
  });
});

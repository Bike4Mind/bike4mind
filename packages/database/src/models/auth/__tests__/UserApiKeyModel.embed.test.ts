import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey } from '../UserApiKeyModel';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';

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

describe('UserApiKeyRepository.findByAgentId', () => {
  it('returns only ACTIVE keys for the agent, newest first', async () => {
    const { userApiKeyRepository } = await import('../UserApiKeyModel');
    await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_agent001',
      agentId: 'agent-9',
      createdAt: new Date('2026-01-01'),
    });
    await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_agent002',
      agentId: 'agent-9',
      createdAt: new Date('2026-02-01'),
    });
    await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_agent003', agentId: 'agent-9', status: 'disabled' });
    await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_other001', agentId: 'agent-other' });

    const keys = await userApiKeyRepository.findByAgentId('agent-9');
    expect(keys.map(k => k.keyPrefix)).toEqual(['b4m_live_agent002', 'b4m_live_agent001']);
  });

  it('returns empty for an agent with no keys', async () => {
    const { userApiKeyRepository } = await import('../UserApiKeyModel');
    await expect(userApiKeyRepository.findByAgentId('agent-none')).resolves.toEqual([]);
  });
});

describe('UserApiKeyRepository.findByOrganizationIdsAndId', () => {
  // Unique keyPrefix per test: the soft-delete plugin makes afterEach's deleteMany
  // a soft delete, so the keyPrefix unique index still sees prior tests' docs.
  async function seed(tag: string) {
    const { userApiKeyRepository } = await import('../UserApiKeyModel');
    const org1 = await UserApiKey.create({
      ...base,
      keyPrefix: `b4m_live_${tag}o1`,
      agentId: 'agent-1',
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'org-1',
    });
    const org2 = await UserApiKey.create({
      ...base,
      keyPrefix: `b4m_live_${tag}o2`,
      agentId: 'agent-1',
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'org-2',
    });
    // Personal (User-billed) key minted by a different user - the shape the guard must exclude.
    const personal = await UserApiKey.create({
      ...base,
      userId: 'other-user',
      keyPrefix: `b4m_live_${tag}p`,
      agentId: 'agent-1',
      billingOwnerType: CreditHolderType.User,
    });
    return { userApiKeyRepository, org1, org2, personal };
  }

  it('returns the key when it is org-billed to an org in the set', async () => {
    const { userApiKeyRepository, org1 } = await seed('a');
    const found = await userApiKeyRepository.findByOrganizationIdsAndId(['org-1'], org1.id);
    expect(found?.id).toBe(org1.id);
  });

  it('excludes a personal (User-billed) key even if its id is passed', async () => {
    const { userApiKeyRepository, personal } = await seed('b');
    await expect(userApiKeyRepository.findByOrganizationIdsAndId(['org-1'], personal.id)).resolves.toBeNull();
  });

  it('returns null for a key billed to an org not in the set', async () => {
    const { userApiKeyRepository, org2 } = await seed('c');
    await expect(userApiKeyRepository.findByOrganizationIdsAndId(['org-1'], org2.id)).resolves.toBeNull();
  });

  it('short-circuits to null for an empty org set', async () => {
    const { userApiKeyRepository, org1 } = await seed('d');
    await expect(userApiKeyRepository.findByOrganizationIdsAndId([], org1.id)).resolves.toBeNull();
  });

  it('returns a hydrated doc (toJSON strips keyHash), matching findByUserIdAndId shape', async () => {
    const { userApiKeyRepository, org1 } = await seed('e');
    const found = await userApiKeyRepository.findByOrganizationIdsAndId(['org-1', 'org-2'], org1.id);
    const json = found!.toJSON() as Record<string, unknown>;
    expect(json.keyHash).toBeUndefined();
    expect(json.organizationId).toBe('org-1');
  });
});

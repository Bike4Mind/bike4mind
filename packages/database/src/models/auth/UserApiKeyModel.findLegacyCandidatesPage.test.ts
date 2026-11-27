import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, CONFINED_API_KEY_SCOPES } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from './UserApiKeyModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
});

const CUTOFF = new Date('2027-01-01T00:00:00Z');
const USED_SINCE = new Date('2026-11-01T00:00:00Z');
let seeded = 0;

const seed = async (name: string, overrides: Record<string, unknown> = {}) => {
  seeded += 1;
  await UserApiKey.collection.insertOne({
    userId: 'owner-1',
    name,
    keyPrefix: `b4m_live_legacy_${seeded}`,
    status: ApiKeyStatus.ACTIVE,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' },
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    lastUsedAt: new Date('2026-11-10T00:00:00Z'),
    ...overrides,
  });
};

const query = (overrides: Partial<Parameters<typeof userApiKeyRepository.findLegacyCandidatesPage>[0]> = {}) =>
  userApiKeyRepository.findLegacyCandidatesPage({
    createdBefore: CUTOFF,
    usedSince: USED_SINCE,
    excludeScopes: CONFINED_API_KEY_SCOPES,
    skip: 0,
    limit: 25,
    ...overrides,
  });

describe('UserApiKeyRepository.findLegacyCandidatesPage', () => {
  it('keeps only active, unexpired, recently used, pre-cutoff, non-confined, non-exchange keys', async () => {
    await seed('match');
    await seed('created after cutoff', { createdAt: new Date('2027-02-01T00:00:00Z') });
    await seed('not used recently', { lastUsedAt: new Date('2026-10-01T00:00:00Z') });
    await seed('never used', { lastUsedAt: undefined });
    await seed('revoked', { status: ApiKeyStatus.DISABLED });
    await seed('expired', { expiresAt: new Date('2020-01-01T00:00:00Z') });
    await seed('confined', { scopes: [ApiKeyScope.EMBED_CHAT] });
    await seed('exchange', { metadata: { createdFrom: 'oauth-exchange' } });
    await seed('deleted', { deletedAt: new Date() });

    const page = await query();

    expect(page.keys.map(key => key.name)).toEqual(['match']);
    expect(page.total).toBe(1);
    expect(page.ownerCount).toBe(1);
  });

  it('matches any creation date while no cutoff is set', async () => {
    await seed('after a future cutoff', { createdAt: new Date('2027-02-01T00:00:00Z') });

    expect((await query({ createdBefore: null })).total).toBe(1);
  });

  it('pages most recently used first, with totals across every page', async () => {
    await seed('oldest', { lastUsedAt: new Date('2026-11-02T00:00:00Z') });
    await seed('newest', { userId: 'owner-2', lastUsedAt: new Date('2026-11-12T00:00:00Z') });
    await seed('middle', { lastUsedAt: new Date('2026-11-05T00:00:00Z') });

    const first = await query({ limit: 2 });
    const second = await query({ skip: 2, limit: 2 });

    expect(first.keys.map(key => key.name)).toEqual(['newest', 'middle']);
    expect(second.keys.map(key => key.name)).toEqual(['oldest']);
    expect(first).toMatchObject({ total: 3, ownerCount: 2 });
  });
});

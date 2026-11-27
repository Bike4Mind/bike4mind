import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
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

const NOW = new Date('2027-01-10T00:00:00Z');
const UNTIL = new Date('2027-01-17T00:00:00Z');
let seeded = 0;

const seed = async (name: string, overrides: Record<string, unknown> = {}) => {
  seeded += 1;
  const result = await UserApiKey.collection.insertOne({
    userId: 'owner-1',
    name,
    keyPrefix: `b4m_live_expiry_${seeded}`,
    status: ApiKeyStatus.ACTIVE,
    scopes: [ApiKeyScope.ME_READ],
    metadata: { createdFrom: 'dashboard' },
    explicitScopeOnly: true,
    expiresAt: new Date('2027-01-14T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  });
  return String(result.insertedId);
};

const names = (docs: { name: string }[]) => docs.map(doc => doc.name).sort();

describe('UserApiKeyRepository.findExpiringExplicitScopeOnly', () => {
  it('matches MCP keys expiring after now and no later than the window end', async () => {
    await seed('inside');
    await seed('at window end', { expiresAt: UNTIL });
    await seed('just past window', { expiresAt: new Date(UNTIL.getTime() + 1) });
    await seed('at now', { expiresAt: NOW });
    await seed('just after now', { expiresAt: new Date(NOW.getTime() + 1) });
    await seed('already expired', { expiresAt: new Date('2027-01-01T00:00:00Z') });

    expect(names(await userApiKeyRepository.findExpiringExplicitScopeOnly(NOW, UNTIL))).toEqual([
      'at window end',
      'inside',
      'just after now',
    ]);
  });

  it('skips ordinary, disabled, never-expiring and already-reminded keys, and matches a missing marker', async () => {
    await seed('match');
    await seed('ordinary', { explicitScopeOnly: undefined });
    await seed('disabled', { status: ApiKeyStatus.DISABLED });
    await seed('no expiry', { expiresAt: undefined });
    await seed('reminded', { expiryReminderSentAt: new Date('2027-01-09T00:00:00Z') });

    expect(names(await userApiKeyRepository.findExpiringExplicitScopeOnly(NOW, UNTIL))).toEqual(['match']);
  });
});

describe('UserApiKeyRepository.claimExpiryReminder / releaseExpiryReminder', () => {
  const claimedAt = new Date('2027-01-10T14:00:00Z');

  it('claims a key exactly once', async () => {
    const id = await seed('k');
    expect(await userApiKeyRepository.claimExpiryReminder(id, claimedAt)).toBe(true);
    expect(await userApiKeyRepository.claimExpiryReminder(id, new Date())).toBe(false);
    expect(await userApiKeyRepository.findExpiringExplicitScopeOnly(NOW, UNTIL)).toEqual([]);
  });

  it('releases a claim so the next sweep picks the key up again', async () => {
    const id = await seed('k');
    await userApiKeyRepository.claimExpiryReminder(id, claimedAt);
    await userApiKeyRepository.releaseExpiryReminder(id, claimedAt);
    expect(names(await userApiKeyRepository.findExpiringExplicitScopeOnly(NOW, UNTIL))).toEqual(['k']);
    expect(await userApiKeyRepository.claimExpiryReminder(id, claimedAt)).toBe(true);
  });

  it('leaves a claim alone when it is no longer the one being released', async () => {
    const id = await seed('k');
    await userApiKeyRepository.claimExpiryReminder(id, claimedAt);
    await userApiKeyRepository.releaseExpiryReminder(id, new Date('2027-01-11T14:00:00Z'));
    expect(await userApiKeyRepository.findExpiringExplicitScopeOnly(NOW, UNTIL)).toEqual([]);
  });
});

describe('UserApiKeyRepository.findExpiredExplicitScopeOnlyByKeyPrefix', () => {
  const past = () => new Date(Date.now() - 86_400_000);
  const find = async (keyPrefix: string) =>
    names(await userApiKeyRepository.findExpiredExplicitScopeOnlyByKeyPrefix(keyPrefix));

  it('returns an active, expired MCP key, and nothing for another prefix', async () => {
    await seed('expired mcp', { keyPrefix: 'p-match', expiresAt: past() });
    expect(await find('p-match')).toEqual(['expired mcp']);
    expect(await find('p-other')).toEqual([]);
  });

  it('refuses a live, ordinary, disabled or never-expiring key', async () => {
    await seed('live', { keyPrefix: 'p-live', expiresAt: new Date(Date.now() + 86_400_000) });
    await seed('ordinary', { keyPrefix: 'p-ordinary', expiresAt: past(), explicitScopeOnly: undefined });
    await seed('disabled', { keyPrefix: 'p-disabled', expiresAt: past(), status: ApiKeyStatus.DISABLED });
    await seed('no expiry', { keyPrefix: 'p-none', expiresAt: undefined });
    for (const prefix of ['p-live', 'p-ordinary', 'p-disabled', 'p-none']) expect(await find(prefix)).toEqual([]);
  });
});

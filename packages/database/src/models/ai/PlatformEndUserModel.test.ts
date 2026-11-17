import { beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_END_USER_SEEN_REFRESH_MS, PlatformEndUser, platformEndUserRepository } from './PlatformEndUserModel';
import { setupMongoTest } from '../../__test__/utils';

const DIGEST = 'ab'.repeat(32);
const input = { providerEndUserId: DIGEST, keyOwnerId: 'owner-1', apiKeyId: 'key-1', endUserId: 'customer_42' };

describe('platformEndUserRepository', () => {
  setupMongoTest();
  // setupMongoTest drops the database, indexes included; the unique index is what makes a fresh row a no-op.
  beforeEach(async () => {
    await PlatformEndUser.ensureIndexes();
  });

  it('creates the row the first time an end user is seen', async () => {
    const now = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, now);

    const row = await platformEndUserRepository.findByProviderEndUserId(DIGEST);
    expect(row).toMatchObject({ ...input, firstSeenAt: now, lastSeenAt: now });
  });

  it('leaves a fresh row alone and refreshes a stale one, keeping firstSeenAt', async () => {
    const first = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, first);

    await platformEndUserRepository.recordSeen(input, new Date(first.getTime() + 60_000));
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-1',
      lastSeenAt: first,
    });

    const later = new Date(first.getTime() + PLATFORM_END_USER_SEEN_REFRESH_MS + 1);
    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, later);
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-2',
      firstSeenAt: first,
      lastSeenAt: later,
    });
    expect(await PlatformEndUser.countDocuments()).toBe(1);
  });

  it('refreshes the key on a fresh row when a different key sends the end user', async () => {
    const first = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, first);

    const soon = new Date(first.getTime() + 60_000);
    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, soon);
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-2',
      firstSeenAt: first,
      lastSeenAt: soon,
    });

    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, new Date(soon.getTime() + 60_000));
    expect((await platformEndUserRepository.findByProviderEndUserId(DIGEST))?.lastSeenAt).toEqual(soon);
    expect(await PlatformEndUser.countDocuments()).toBe(1);
  });

  it('answers null for an unknown identifier', async () => {
    expect(await platformEndUserRepository.findByProviderEndUserId('cd'.repeat(32))).toBeNull();
  });
});

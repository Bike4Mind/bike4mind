import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { PhoneUnlockClaim, phoneUnlockClaimRepository as repo } from './PhoneUnlockClaimModel';

setupMongoTest();

// The shared cleanup drops indexes between tests.
beforeEach(async () => {
  await PhoneUnlockClaim.createIndexes();
});

describe('phoneUnlockClaimRepository.claim', () => {
  it('lets the first user claim a number', async () => {
    expect(await repo.claim('h1', 'u1')).toEqual({ claimed: true, owner: 'u1' });
    expect(await repo.ownerOf('h1')).toBe('u1');
  });

  it('treats a retry by the same user as claimed', async () => {
    await repo.claim('h2', 'u1');
    expect(await repo.claim('h2', 'u1')).toEqual({ claimed: true, owner: 'u1' });
    expect(await PhoneUnlockClaim.countDocuments({ phoneHash: 'h2' })).toBe(1);
  });

  it('refuses a different user and reports the owner', async () => {
    await repo.claim('h3', 'u1');
    expect(await repo.claim('h3', 'u2')).toEqual({ claimed: false, owner: 'u1' });
  });

  it('lets exactly one of two concurrent users win', async () => {
    const results = await Promise.all([repo.claim('h4', 'u1'), repo.claim('h4', 'u2')]);
    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(results[0].owner).toBe(results[1].owner);
    expect(await PhoneUnlockClaim.countDocuments({ phoneHash: 'h4' })).toBe(1);
  });

  it('frees the number only for the user who holds it', async () => {
    await repo.claim('h5', 'u1');
    await repo.release('h5', 'u2');
    expect(await repo.ownerOf('h5')).toBe('u1');
    await repo.release('h5', 'u1');
    expect(await repo.ownerOf('h5')).toBeNull();
  });
});

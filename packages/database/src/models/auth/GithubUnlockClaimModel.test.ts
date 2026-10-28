import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { GithubUnlockClaim, githubUnlockClaimRepository as repo } from './GithubUnlockClaimModel';

setupMongoTest();

// The shared cleanup drops indexes between tests.
beforeEach(async () => {
  await GithubUnlockClaim.createIndexes();
});

describe('githubUnlockClaimRepository.claim', () => {
  it('lets the first user claim a GitHub id', async () => {
    expect(await repo.claim(101, 'u1')).toEqual({ claimed: true, owner: 'u1' });
  });

  it('treats a retry by the same user as claimed', async () => {
    await repo.claim(102, 'u1');
    expect(await repo.claim(102, 'u1')).toEqual({ claimed: true, owner: 'u1' });
    expect(await GithubUnlockClaim.countDocuments({ githubId: 102 })).toBe(1);
  });

  it('refuses a different user and reports the owner', async () => {
    await repo.claim(103, 'u1');
    expect(await repo.claim(103, 'u2')).toEqual({ claimed: false, owner: 'u1' });
  });

  it('lets exactly one of two concurrent users win', async () => {
    const results = await Promise.all([repo.claim(104, 'u1'), repo.claim(104, 'u2')]);
    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(results[0].owner).toBe(results[1].owner);
    expect(await GithubUnlockClaim.countDocuments({ githubId: 104 })).toBe(1);
  });
});

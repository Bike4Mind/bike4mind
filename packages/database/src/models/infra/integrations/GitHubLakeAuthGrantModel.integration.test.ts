import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { GitHubLakeAuthGrant, gitHubLakeAuthGrantRepository } from './GitHubLakeAuthGrantModel';

/**
 * The server-side half of the authorize-first GitHub lake connect (githubLakeAuthGrant.ts): one
 * live grant per browser flow (nonceHash), replaced rather than duplicated on a second authorize,
 * and single-take on consume so two concurrent completions cannot both claim it.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const base = {
  nonceHash: 'nonce-hash-1',
  userId: 'user-1',
  dataLakeId: 'lake-1',
  encryptedToken: 'enc(token-1)',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await GitHubLakeAuthGrant.createIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await GitHubLakeAuthGrant.deleteMany({});
});

describe('GitHubLakeAuthGrantModel - replace', () => {
  it('creates a grant for a fresh nonce and returns null (nothing to replace)', async () => {
    const previous = await gitHubLakeAuthGrantRepository.replace(base);
    expect(previous).toBeNull();
    const stored = await GitHubLakeAuthGrant.findOne({ nonceHash: base.nonceHash }).lean();
    expect(stored).toMatchObject({ userId: 'user-1', dataLakeId: 'lake-1', encryptedToken: 'enc(token-1)' });
  });

  it('returns the previous grant and overwrites it when the same nonce authorizes again', async () => {
    await gitHubLakeAuthGrantRepository.replace(base);
    const replaced = await gitHubLakeAuthGrantRepository.replace({ ...base, encryptedToken: 'enc(token-2)' });
    expect(replaced).toMatchObject({ nonceHash: base.nonceHash, encryptedToken: 'enc(token-1)' });

    const stored = await GitHubLakeAuthGrant.findOne({ nonceHash: base.nonceHash }).lean();
    expect(stored).toMatchObject({ encryptedToken: 'enc(token-2)' });
    expect(await GitHubLakeAuthGrant.countDocuments({ nonceHash: base.nonceHash })).toBe(1);
  });
});

describe('GitHubLakeAuthGrantModel - findLive', () => {
  it('resolves a grant that has not expired', async () => {
    await gitHubLakeAuthGrantRepository.replace(base);
    expect(await gitHubLakeAuthGrantRepository.findLive(base.nonceHash)).toMatchObject({
      nonceHash: base.nonceHash,
      userId: 'user-1',
    });
  });

  it('ignores an expired grant', async () => {
    await gitHubLakeAuthGrantRepository.replace({ ...base, expiresAt: new Date(Date.now() - 1000) });
    expect(await gitHubLakeAuthGrantRepository.findLive(base.nonceHash)).toBeNull();
  });

  it('resolves null for a nonce with no grant', async () => {
    expect(await gitHubLakeAuthGrantRepository.findLive('no-such-nonce')).toBeNull();
  });
});

describe('GitHubLakeAuthGrantModel - consume', () => {
  it('deletes and returns the grant', async () => {
    await gitHubLakeAuthGrantRepository.replace(base);
    const consumed = await gitHubLakeAuthGrantRepository.consume(base.nonceHash);
    expect(consumed).toMatchObject({ nonceHash: base.nonceHash });
    expect(await GitHubLakeAuthGrant.findOne({ nonceHash: base.nonceHash })).toBeNull();
  });

  it('is a single take: a second concurrent consume finds nothing', async () => {
    await gitHubLakeAuthGrantRepository.replace(base);
    const [first, second] = await Promise.all([
      gitHubLakeAuthGrantRepository.consume(base.nonceHash),
      gitHubLakeAuthGrantRepository.consume(base.nonceHash),
    ]);
    const results = [first, second];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(r => r === null)).toHaveLength(1);
  });

  it('returns null for a nonce with no grant', async () => {
    expect(await gitHubLakeAuthGrantRepository.consume('no-such-nonce')).toBeNull();
  });
});

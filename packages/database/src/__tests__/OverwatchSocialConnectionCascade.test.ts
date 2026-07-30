import { describe, it, expect, beforeEach } from 'vitest';
import {
  OverwatchSocialConnection,
  overwatchSocialConnectionRepository,
} from '../models/social/OverwatchSocialConnectionModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await OverwatchSocialConnection.deleteMany({});
  await OverwatchSocialConnection.syncIndexes();
});

const connection = (productId: string, platform: string, over: Record<string, unknown> = {}) => ({
  productId,
  platform,
  handle: `${productId}-${platform}`,
  accessToken: 'encrypted-access',
  refreshToken: 'encrypted-refresh',
  status: 'active' as const,
  ...over,
});

describe('overwatchSocialConnectionRepository.listByProduct', () => {
  it('returns every platform for one product', async () => {
    await OverwatchSocialConnection.create([connection('vibeswire', 'linkedin'), connection('vibeswire', 'youtube')]);

    const found = await overwatchSocialConnectionRepository.listByProduct('vibeswire');

    expect(found.map(c => c.platform).sort()).toEqual(['linkedin', 'youtube']);
  });

  it('does not leak another product’s connections', async () => {
    await OverwatchSocialConnection.create([connection('vibeswire', 'linkedin'), connection('k2kanji', 'linkedin')]);

    const found = await overwatchSocialConnectionRepository.listByProduct('vibeswire');

    expect(found).toHaveLength(1);
    expect(found[0].productId).toBe('vibeswire');
  });

  it('excludes credential fields so results are safe to log', async () => {
    await OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'));

    const [found] = await overwatchSocialConnectionRepository.listByProduct('vibeswire');

    expect(found.accessToken).toBeUndefined();
    expect(found.refreshToken).toBeUndefined();
    // The id is what the caller needs to revoke each one at its platform.
    expect(found.id).toBeDefined();
  });

  it('returns empty for an unknown product', async () => {
    expect(await overwatchSocialConnectionRepository.listByProduct('nope')).toEqual([]);
  });

  it('returns empty for a blank productId rather than matching everything', async () => {
    await OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'));
    expect(await overwatchSocialConnectionRepository.listByProduct('')).toEqual([]);
  });
});

describe('overwatchSocialConnectionRepository.deleteByProduct', () => {
  it('removes every connection for the product and reports the count', async () => {
    await OverwatchSocialConnection.create([
      connection('vibeswire', 'linkedin'),
      connection('vibeswire', 'youtube'),
      connection('vibeswire', 'facebook'),
    ]);

    const deleted = await overwatchSocialConnectionRepository.deleteByProduct('vibeswire');

    expect(deleted).toBe(3);
    expect(await OverwatchSocialConnection.countDocuments({ productId: 'vibeswire' })).toBe(0);
  });

  it('leaves other products untouched', async () => {
    await OverwatchSocialConnection.create([connection('vibeswire', 'linkedin'), connection('k2kanji', 'linkedin')]);

    await overwatchSocialConnectionRepository.deleteByProduct('vibeswire');

    expect(await OverwatchSocialConnection.countDocuments({ productId: 'k2kanji' })).toBe(1);
  });

  it('deletes revoked connections too — a revoked row is still a row', async () => {
    await OverwatchSocialConnection.create([
      connection('vibeswire', 'linkedin', { status: 'revoked' }),
      connection('vibeswire', 'youtube', { status: 'requires_reauth' }),
    ]);

    expect(await overwatchSocialConnectionRepository.deleteByProduct('vibeswire')).toBe(2);
  });

  it('is a no-op returning 0 for a product with no connections', async () => {
    expect(await overwatchSocialConnectionRepository.deleteByProduct('vibeswire')).toBe(0);
  });

  it('refuses a blank productId rather than deleting the collection', async () => {
    // The dangerous case: deleteMany({ productId: '' }) would be a no-op, but an
    // undefined slipping through to deleteMany({}) would not. Guard is explicit.
    await OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'));

    expect(await overwatchSocialConnectionRepository.deleteByProduct('')).toBe(0);
    expect(await OverwatchSocialConnection.countDocuments({})).toBe(1);
  });

  it('is idempotent — deleting twice is safe', async () => {
    await OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'));

    expect(await overwatchSocialConnectionRepository.deleteByProduct('vibeswire')).toBe(1);
    expect(await overwatchSocialConnectionRepository.deleteByProduct('vibeswire')).toBe(0);
  });

  it('frees the unique (productId, platform) slot for reuse', async () => {
    // A product re-created with the same id must be able to reconnect the same
    // platform; a lingering row would collide with the unique index.
    await OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'));
    await overwatchSocialConnectionRepository.deleteByProduct('vibeswire');

    await expect(OverwatchSocialConnection.create(connection('vibeswire', 'linkedin'))).resolves.toBeDefined();
  });
});

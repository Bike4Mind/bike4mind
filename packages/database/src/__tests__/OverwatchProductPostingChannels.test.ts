import { describe, it, expect, beforeEach } from 'vitest';
import { OverwatchProduct, overwatchProductRepository } from '../models/infra/ops/OverwatchProductModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await OverwatchProduct.deleteMany({});
  await OverwatchProduct.syncIndexes();
});

const base = {
  productId: 'vibeswire',
  name: 'VibesWire',
  gaPropertyId: '',
  socialLinks: [],
  customEvents: [],
  campaignLinks: [],
  status: 'active' as const,
};

const channel = (over: Record<string, unknown> = {}) => ({
  label: 'r/selfhosted',
  url: 'https://reddit.com/r/selfhosted',
  platform: 'reddit',
  notes: 'Self-promo limited to 1 in 10 posts; mods enforce it.',
  ...over,
});

describe('OverwatchProduct.postingChannels', () => {
  it('defaults to an empty array so callers can iterate unconditionally', async () => {
    const saved = await overwatchProductRepository.upsertProduct(base);
    expect(saved.postingChannels).toEqual([]);
  });

  describe('documents stored before the field existed', () => {
    // Insert through the driver so schema defaults never run - this is exactly what a
    // product written before `postingChannels` existed looks like on disk. Schema defaults
    // do not apply to `.lean()` reads, so without repository normalization every one of
    // these reads hands back `undefined` and breaks the iterate-unconditionally contract.
    beforeEach(async () => {
      await OverwatchProduct.collection.insertOne({
        productId: 'legacy',
        name: 'Legacy Product',
        socialLinks: [],
        customEvents: [],
        campaignLinks: [],
        status: 'active',
      } as never);
    });

    it('reads back an empty array from getByProductId', async () => {
      const found = await overwatchProductRepository.getByProductId('legacy');
      expect(found?.postingChannels).toEqual([]);
    });

    it('reads back an empty array from the list queries', async () => {
      expect((await overwatchProductRepository.getAllProducts())[0].postingChannels).toEqual([]);
      expect((await overwatchProductRepository.getActiveProducts())[0].postingChannels).toEqual([]);
    });

    it('reads back an empty array from an upsert that omits the field', async () => {
      const saved = await overwatchProductRepository.upsertProduct({
        ...base,
        productId: 'legacy',
        name: 'Legacy Renamed',
      });
      expect(saved.postingChannels).toEqual([]);
    });
  });

  it('round-trips label, url, platform and notes', async () => {
    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [channel()] });

    const found = await overwatchProductRepository.getByProductId('vibeswire');

    expect(found?.postingChannels).toHaveLength(1);
    expect(found?.postingChannels[0]).toMatchObject({
      label: 'r/selfhosted',
      url: 'https://reddit.com/r/selfhosted',
      platform: 'reddit',
      notes: 'Self-promo limited to 1 in 10 posts; mods enforce it.',
    });
  });

  it('accepts an entry with only label and url', async () => {
    await overwatchProductRepository.upsertProduct({
      ...base,
      postingChannels: [{ label: 'Hacker News', url: 'https://news.ycombinator.com' }],
    });

    const found = await overwatchProductRepository.getByProductId('vibeswire');
    expect(found?.postingChannels[0].platform).toBeUndefined();
    expect(found?.postingChannels[0].notes).toBeUndefined();
  });

  it('requires label and url', async () => {
    await expect(OverwatchProduct.create({ ...base, postingChannels: [{ url: 'https://x.test' }] })).rejects.toThrow();
    await expect(OverwatchProduct.create({ ...base, postingChannels: [{ label: 'no url' }] })).rejects.toThrow();
  });

  it('leaves stored channels untouched when a caller omits the field', async () => {
    // The compatibility guarantee: `postingChannels` is optional on the write path, and
    // omitting it must not wipe what is already there - a caller that predates the field
    // (or simply doesn't manage it) can still update a product safely.
    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [channel()] });

    await overwatchProductRepository.upsertProduct({ ...base, name: 'VibesWire Renamed' });

    const found = await overwatchProductRepository.getByProductId('vibeswire');
    expect(found?.name).toBe('VibesWire Renamed');
    expect(found?.postingChannels).toHaveLength(1);
  });

  it('replaces the list when explicitly supplied', async () => {
    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [channel()] });

    await overwatchProductRepository.upsertProduct({
      ...base,
      postingChannels: [channel({ label: 'r/homelab', url: 'https://reddit.com/r/homelab' })],
    });

    const found = await overwatchProductRepository.getByProductId('vibeswire');
    expect(found?.postingChannels).toHaveLength(1);
    expect(found?.postingChannels[0].label).toBe('r/homelab');
  });

  it('can be cleared with an explicit empty array', async () => {
    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [channel()] });

    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [] });

    const found = await overwatchProductRepository.getByProductId('vibeswire');
    expect(found?.postingChannels).toEqual([]);
  });

  it('keeps channels per product rather than shared', async () => {
    await overwatchProductRepository.upsertProduct({ ...base, postingChannels: [channel()] });
    await overwatchProductRepository.upsertProduct({
      ...base,
      productId: 'k2kanji',
      name: 'K2Kanji',
      postingChannels: [channel({ label: 'r/LearnJapanese', url: 'https://reddit.com/r/LearnJapanese' })],
    });

    expect((await overwatchProductRepository.getByProductId('vibeswire'))?.postingChannels[0].label).toBe(
      'r/selfhosted'
    );
    expect((await overwatchProductRepository.getByProductId('k2kanji'))?.postingChannels[0].label).toBe(
      'r/LearnJapanese'
    );
  });
});

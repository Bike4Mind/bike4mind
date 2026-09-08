import { describe, it, expect, beforeEach } from 'vitest';
import { OverwatchProduct, overwatchProductRepository } from '../models/infra/ops/OverwatchProductModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await OverwatchProduct.deleteMany({});
  await OverwatchProduct.syncIndexes();
});

/**
 * `upsertProduct` writes `{ $set: data }`, so omitting a key preserves the stored value
 * and supplying an empty one overwrites it. These tests pin the omission half for every
 * field that is optional on the write path: a caller that does not know about a field
 * must not be able to destroy it, and the only way to express that is to leave the key
 * out entirely.
 *
 * The distinction is invisible in the return value of a single call, which is why each
 * test writes a value, writes again without it, and then reads the document back.
 */

/** The minimum a caller must supply: everything else is optional on this path. */
const identity = { productId: 'vibeswire', name: 'VibesWire' };

const socialLink = { platform: 'x', url: 'https://x.com/vibeswire', handle: '@vibeswire' };
const customEvent = { name: 'signup_completed', label: 'Signup completed' };
const campaignLink = { label: 'Launch', url: 'https://vibeswire.com/?utm_campaign=launch' };
const postingChannel = {
  label: 'r/selfhosted',
  url: 'https://reddit.com/r/selfhosted',
  platform: 'reddit',
  notes: 'Self-promo limited to 1 in 10 posts.',
};

describe('upsertProduct partial updates', () => {
  it('creates a product from identity fields alone', async () => {
    // If any of the five were still required this call would not compile, which is the
    // property the rest of these tests depend on.
    const saved = await overwatchProductRepository.upsertProduct(identity);

    expect(saved).toMatchObject({ productId: 'vibeswire', name: 'VibesWire' });
    // Schema defaults apply on the upsert-insert, so a caller that supplied nothing still
    // gets a document every reader can iterate unconditionally.
    expect(saved.socialLinks).toEqual([]);
    expect(saved.customEvents).toEqual([]);
    expect(saved.campaignLinks).toEqual([]);
    expect(saved.postingChannels).toEqual([]);
    expect(saved.status).toBe('active');
  });

  describe('omitting a field preserves it', () => {
    it('preserves socialLinks', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, socialLinks: [socialLink] });
      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.socialLinks).toHaveLength(1);
      expect(doc?.name).toBe('VibesWire Renamed');
    });

    it('preserves customEvents', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, customEvents: [customEvent] });
      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.customEvents).toHaveLength(1);
    });

    it('preserves campaignLinks', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, campaignLinks: [campaignLink] });
      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.campaignLinks).toHaveLength(1);
    });

    it('preserves postingChannels', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, postingChannels: [postingChannel] });
      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.postingChannels).toHaveLength(1);
    });

    it('preserves an inactive status', async () => {
      // The sharpest of the five. The other four empty a list; this one silently returns a
      // product to service. A caller editing an unrelated field has no reason to send a
      // status, and before this was optional it had no way to avoid sending one.
      await overwatchProductRepository.upsertProduct({ ...identity, status: 'inactive' });
      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.status).toBe('inactive');
    });

    it('preserves every field across an identity-only write', async () => {
      // All five at once: a partial update touching nothing but the name must leave the
      // whole rest of the document standing.
      await overwatchProductRepository.upsertProduct({
        ...identity,
        socialLinks: [socialLink],
        customEvents: [customEvent],
        campaignLinks: [campaignLink],
        postingChannels: [postingChannel],
        status: 'inactive',
      });

      await overwatchProductRepository.upsertProduct({ ...identity, name: 'VibesWire Renamed' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc).toMatchObject({
        name: 'VibesWire Renamed',
        status: 'inactive',
      });
      expect(doc?.socialLinks).toHaveLength(1);
      expect(doc?.customEvents).toHaveLength(1);
      expect(doc?.campaignLinks).toHaveLength(1);
      expect(doc?.postingChannels).toHaveLength(1);
    });
  });

  describe('supplying a field still overwrites it', () => {
    // The other half of the contract. Optional must not become unwritable: clearing a list
    // deliberately, or deactivating a product, has to keep working.
    it('clears a list when an empty array is supplied', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, socialLinks: [socialLink] });
      await overwatchProductRepository.upsertProduct({ ...identity, socialLinks: [] });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.socialLinks).toEqual([]);
    });

    it('deactivates a product when a status is supplied', async () => {
      await overwatchProductRepository.upsertProduct(identity);
      await overwatchProductRepository.upsertProduct({ ...identity, status: 'inactive' });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.status).toBe('inactive');
    });

    it('replaces a list rather than merging into it', async () => {
      await overwatchProductRepository.upsertProduct({ ...identity, customEvents: [customEvent] });
      await overwatchProductRepository.upsertProduct({
        ...identity,
        customEvents: [{ name: 'purchase', label: 'Purchase' }],
      });

      const doc = await OverwatchProduct.findOne({ productId: 'vibeswire' }).lean();
      expect(doc?.customEvents).toHaveLength(1);
      expect(doc?.customEvents[0].name).toBe('purchase');
    });
  });
});

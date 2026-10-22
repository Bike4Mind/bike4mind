import { describe, it, expect, beforeEach } from 'vitest';
import { OverwatchProduct, overwatchProductRepository } from '../models/infra/ops/OverwatchProductModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

const ARRAY_FIELDS = ['socialLinks', 'customEvents', 'campaignLinks', 'postingChannels'] as const;

// Insert through the driver so schema defaults never run: a product stored without its
// array fields. `.lean()` reads skip schema defaults too, so without repository
// normalization these come back `undefined` and break callers that read `.length`.
beforeEach(async () => {
  await OverwatchProduct.deleteMany({});
  await OverwatchProduct.syncIndexes();
  await OverwatchProduct.collection.insertOne({
    productId: 'bare',
    name: 'Bare Product',
    gaPropertyId: 'properties/123',
    status: 'active',
  } as never);
});

describe('OverwatchProduct array fields missing on disk', () => {
  it.each(ARRAY_FIELDS)('getByProductId reads back %s as an empty array', async field => {
    const found = await overwatchProductRepository.getByProductId('bare');
    expect(found?.[field]).toEqual([]);
  });

  it.each(ARRAY_FIELDS)('the list queries read back %s as an empty array', async field => {
    expect((await overwatchProductRepository.getAllProducts())[0][field]).toEqual([]);
    expect((await overwatchProductRepository.getActiveProducts())[0][field]).toEqual([]);
  });

  it('keeps stored values when present', async () => {
    await OverwatchProduct.collection.updateOne(
      { productId: 'bare' },
      { $set: { customEvents: [{ name: 'subscribe', label: 'Signups' }] } }
    );
    const found = await overwatchProductRepository.getByProductId('bare');
    expect(found?.customEvents).toEqual([{ name: 'subscribe', label: 'Signups' }]);
  });
});

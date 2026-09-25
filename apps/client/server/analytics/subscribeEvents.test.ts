// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockKeyFor } = vi.hoisted(() => ({ mockEmit: vi.fn(), mockKeyFor: vi.fn() }));
vi.mock('./emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: mockEmit,
  ingestKeyFor: mockKeyFor,
}));

import { stableEventId } from './acquisition';
import { emitSubscribeForSourceProducts } from './subscribeEvents';

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockKeyFor.mockImplementation((p: string) => (p === 'widgets' || p === 'gadgets' ? 'key' : undefined));
});

describe('emitSubscribeForSourceProducts', () => {
  it('sends one subscribe per source product that has a key, marked with its touch', async () => {
    const sent = await emitSubscribeForSourceProducts({
      userId: 'u1',
      subscriptionId: 'sub_1',
      priceId: 'price_pro',
      touches: { firstTouch: { source: 'widgets', medium: 'teaser' }, lastTouch: { source: 'gadgets' } },
    });
    expect(sent).toEqual(['widgets', 'gadgets']);
    expect(mockEmit).toHaveBeenCalledWith({
      productId: 'widgets',
      event: 'subscribe',
      eventId: stableEventId('subscribe', 'widgets', 'sub_1'),
      userId: 'u1',
      utm: { source: 'widgets', medium: 'teaser' },
      metadata: { touch: 'first', priceId: 'price_pro' },
    });
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ productId: 'gadgets', metadata: { touch: 'last', priceId: 'price_pro' } }));
  });

  it('sends once, as both, when first and last touch are the same product', async () => {
    await emitSubscribeForSourceProducts({
      userId: 'u1',
      subscriptionId: 'sub_1',
      touches: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'widgets', medium: 'landing' } },
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].metadata).toEqual({ touch: 'both' });
  });

  it('sends nothing for the host product, a keyless source, or no touches, and never throws', async () => {
    mockEmit.mockRejectedValue(new Error('down'));
    await expect(
      emitSubscribeForSourceProducts({
        userId: 'u1',
        subscriptionId: 'sub_1',
        touches: { firstTouch: { source: 'bike4mind' }, lastTouch: { source: 'newsletter' } },
      })
    ).resolves.toEqual([]);
    await expect(emitSubscribeForSourceProducts({ userId: 'u1', subscriptionId: 's', touches: undefined })).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();

    await expect(
      emitSubscribeForSourceProducts({ userId: 'u1', subscriptionId: 's', touches: { lastTouch: { source: 'widgets' } } })
    ).resolves.toEqual(['widgets']);
  });
});

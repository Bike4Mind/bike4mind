// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockKeyFor } = vi.hoisted(() => ({ mockEmit: vi.fn(), mockKeyFor: vi.fn() }));
vi.mock('./emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: mockEmit,
  ingestKeyFor: mockKeyFor,
}));

import { emitSignupForSourceProducts, emitSubscribeForSourceProducts, stableEventId } from './subscribeEvents';

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
      metadata: { touch: 'first', attribution: 'self-reported', priceId: 'price_pro' },
    });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'gadgets',
        metadata: { touch: 'last', attribution: 'self-reported', priceId: 'price_pro' },
      })
    );
  });

  it('sends once, as both, when first and last touch are the same product', async () => {
    await emitSubscribeForSourceProducts({
      userId: 'u1',
      subscriptionId: 'sub_1',
      touches: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'widgets', medium: 'landing' } },
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].metadata).toEqual({ touch: 'both', attribution: 'self-reported' });
  });

  it('marks every event self-reported, whichever product it credits', async () => {
    // The productId is read from a cookie the browser set, so a consumer has to be able to see
    // that the credit is a visitor's claim rather than anything this server observed. Assert it
    // on every call rather than one, so a later branch cannot quietly send an unmarked event.
    await emitSubscribeForSourceProducts({
      userId: 'u1',
      subscriptionId: 'sub_1',
      touches: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'gadgets' } },
    });
    expect(mockEmit).toHaveBeenCalledTimes(2);
    for (const [call] of mockEmit.mock.calls) {
      expect(call.metadata).toMatchObject({ attribution: 'self-reported' });
    }
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
    await expect(
      emitSubscribeForSourceProducts({ userId: 'u1', subscriptionId: 's', touches: undefined })
    ).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();

    await expect(
      emitSubscribeForSourceProducts({
        userId: 'u1',
        subscriptionId: 's',
        touches: { lastTouch: { source: 'widgets' } },
      })
    ).resolves.toEqual(['widgets']);
  });
});

describe('emitSignupForSourceProducts', () => {
  it('sends one signup per source product, keyed to the user so a retry sends the same id', async () => {
    const sent = await emitSignupForSourceProducts({
      userId: 'u1',
      method: 'otc',
      touches: { firstTouch: { source: 'widgets', medium: 'teaser' }, lastTouch: { source: 'widgets' } },
    });
    expect(sent).toEqual(['widgets']);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith({
      productId: 'widgets',
      event: 'signup',
      eventId: stableEventId('signup', 'widgets', 'u1'),
      userId: 'u1',
      utm: { source: 'widgets', medium: 'teaser' },
      metadata: { touch: 'both', attribution: 'self-reported', method: 'otc' },
    });
  });

  it('marks every signup self-reported and never credits the host or a keyless source', async () => {
    await emitSignupForSourceProducts({
      userId: 'u1',
      method: 'google',
      touches: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'gadgets' } },
    });
    expect(mockEmit).toHaveBeenCalledTimes(2);
    for (const [call] of mockEmit.mock.calls) {
      expect(call.metadata).toMatchObject({ attribution: 'self-reported', method: 'google' });
    }

    mockEmit.mockClear();
    await expect(
      emitSignupForSourceProducts({
        userId: 'u1',
        method: 'otc',
        touches: { firstTouch: { source: 'bike4mind' }, lastTouch: { source: 'newsletter' } },
      })
    ).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws when the emitter fails', async () => {
    mockEmit.mockRejectedValue(new Error('down'));
    await expect(
      emitSignupForSourceProducts({ userId: 'u1', method: 'otc', touches: { lastTouch: { source: 'widgets' } } })
    ).resolves.toEqual(['widgets']);
  });

  // The host guard is only reachable when the host HAS a key, which is the production case:
  // OVERWATCH_INGEST_KEY is what ingestKeyFor returns for bike4mind. With the default mock (keys
  // for widgets/gadgets only) the host falls out on the keyless check instead, so deleting
  // `productId === HOST_PRODUCT_ID` left every test in this file passing.
  it('still excludes the host when the host has an ingest key, and sends the others', async () => {
    mockKeyFor.mockImplementation((p: string) =>
      p === 'widgets' || p === 'gadgets' || p === 'bike4mind' ? 'key' : undefined
    );

    await expect(
      emitSignupForSourceProducts({
        userId: 'u1',
        method: 'google',
        touches: { firstTouch: { source: 'bike4mind' }, lastTouch: { source: 'widgets' } },
      })
    ).resolves.toEqual(['widgets']);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ productId: 'widgets' });
  });

  it('attempts every product even when one of them rejects', async () => {
    mockEmit.mockImplementation((opts: { productId: string }) =>
      opts.productId === 'widgets' ? Promise.reject(new Error('down')) : Promise.resolve(undefined)
    );

    // Both are attempted and the rejection is swallowed, so both appear in the result - which is
    // why the docblock calls these attempts rather than deliveries.
    await expect(
      emitSignupForSourceProducts({
        userId: 'u1',
        method: 'otc',
        touches: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'gadgets' } },
      })
    ).resolves.toEqual(['widgets', 'gadgets']);
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });
});

describe('stableEventId', () => {
  it('is a UUID-shaped id, the same for the same parts and different otherwise', () => {
    const a = stableEventId('subscribe', 'widgets', 'sub_1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventId('subscribe', 'widgets', 'sub_1')).toBe(a);
    expect(stableEventId('subscribe', 'widgets', 'sub_2')).not.toBe(a);
  });
});

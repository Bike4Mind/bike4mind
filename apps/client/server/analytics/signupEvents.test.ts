// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockKeyFor } = vi.hoisted(() => ({ mockEmit: vi.fn(), mockKeyFor: vi.fn() }));
vi.mock('./emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: mockEmit,
  ingestKeyFor: mockKeyFor,
}));
vi.mock('@server/utils/config', () => ({ Config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' } }));

import { pseudonymize } from './pseudonymize';
import {
  emitPurchaseForSourceProducts,
  emitSignupForSourceProducts,
  stableEventId,
  type PurchaseCreditUser,
} from './signupEvents';

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockKeyFor.mockImplementation((p: string) => (p === 'widgets' || p === 'gadgets' ? 'key' : undefined));
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
      eventId: stableEventId('signup', 'widgets', pseudonymize('u1', 'test-salt')),
      userId: 'u1',
      utm: { source: 'widgets', medium: 'teaser' },
      metadata: { touch: 'both', attribution: 'self-reported', method: 'otc' },
    });
  });

  // The eventId reaches the credited product verbatim. An unsalted hash of the raw id would let it
  // recover the host's user id (an ObjectId is a timestamp plus 5 random bytes), so the id must
  // be built from the salted pseudonym it already receives as userId.
  it('never builds the eventId from the raw user id', async () => {
    await emitSignupForSourceProducts({ userId: 'u1', method: 'otc', touches: { lastTouch: { source: 'widgets' } } });
    expect(mockEmit.mock.calls[0][0].eventId).not.toBe(stableEventId('signup', 'widgets', 'u1'));
  });

  it('sends to each of two distinct source products, marked with its own touch', async () => {
    await emitSignupForSourceProducts({
      userId: 'u1',
      method: 'otc',
      touches: { firstTouch: { source: 'widgets', medium: 'teaser' }, lastTouch: { source: 'gadgets' } },
    });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'widgets', utm: { source: 'widgets', medium: 'teaser' } })
    );
    expect(mockEmit.mock.calls.map(([call]) => [call.productId, call.metadata.touch])).toEqual([
      ['widgets', 'first'],
      ['gadgets', 'last'],
    ]);
  });

  it('sends nothing when there are no touches', async () => {
    await expect(emitSignupForSourceProducts({ userId: 'u1', method: 'otc', touches: undefined })).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
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

describe('emitPurchaseForSourceProducts', () => {
  const user = (acquisition?: PurchaseCreditUser['acquisition']): PurchaseCreditUser => ({ id: 'u1', acquisition });
  const invoice = (over: Partial<Parameters<typeof emitPurchaseForSourceProducts>[0]> = {}) => ({
    user: user({ firstTouch: { source: 'widgets', campaign: 'launch' } }),
    paymentId: 'in_1',
    kind: 'subscription' as const,
    amountMinor: 2999,
    currency: 'usd',
    billingReason: 'subscription_create',
    ...over,
  });

  it('credits the stored first touch with the amount in major units, keyed on the payment', async () => {
    await expect(emitPurchaseForSourceProducts(invoice())).resolves.toEqual(['widgets']);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith({
      productId: 'widgets',
      event: 'purchase',
      eventId: stableEventId('purchase', 'widgets', 'in_1'),
      userId: 'u1',
      utm: { source: 'widgets', campaign: 'launch' },
      metadata: {
        touch: 'first',
        attribution: 'self-reported',
        kind: 'subscription',
        value: 29.99,
        currency: 'USD',
        billingReason: 'subscription_create',
      },
    });
  });

  it('credits the stored last touch, and marks a product named by both touches once as both', async () => {
    await emitPurchaseForSourceProducts(invoice({ user: user({ lastTouch: { source: 'gadgets' } }) }));
    expect(mockEmit.mock.calls.map(([c]) => [c.productId, c.metadata.touch])).toEqual([['gadgets', 'last']]);

    mockEmit.mockClear();
    await emitPurchaseForSourceProducts(
      invoice({ user: user({ firstTouch: { source: 'widgets' }, lastTouch: { source: 'widgets' } }) })
    );
    expect(mockEmit.mock.calls.map(([c]) => [c.productId, c.metadata.touch])).toEqual([['widgets', 'both']]);

    mockEmit.mockClear();
    await expect(
      emitPurchaseForSourceProducts(
        invoice({ user: user({ firstTouch: { source: 'widgets' }, lastTouch: { source: 'gadgets' } }) })
      )
    ).resolves.toEqual(['widgets', 'gadgets']);
  });

  it('credits a credit pack under its payment intent, without a billing reason', async () => {
    await emitPurchaseForSourceProducts(
      invoice({ paymentId: 'pi_9', kind: 'credits', amountMinor: 999, billingReason: undefined })
    );
    const [call] = mockEmit.mock.calls[0];
    expect(call.eventId).toBe(stableEventId('purchase', 'widgets', 'pi_9'));
    expect(call.metadata).toEqual({
      touch: 'first',
      attribution: 'self-reported',
      kind: 'credits',
      value: 9.99,
      currency: 'USD',
    });
  });

  it('sends the same eventId for a redelivered payment and a different one for another payment', async () => {
    await emitPurchaseForSourceProducts(invoice());
    await emitPurchaseForSourceProducts(invoice());
    await emitPurchaseForSourceProducts(invoice({ paymentId: 'in_2' }));
    const ids = mockEmit.mock.calls.map(([c]) => c.eventId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('never credits the host or a keyless source, even when the host has a key', async () => {
    mockKeyFor.mockImplementation((p: string) => (p === 'widgets' || p === 'bike4mind' ? 'key' : undefined));
    await expect(
      emitPurchaseForSourceProducts(
        invoice({ user: user({ firstTouch: { source: 'bike4mind' }, lastTouch: { source: 'newsletter' } }) })
      )
    ).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('sends nothing for a user with no stored acquisition, or no user at all', async () => {
    await expect(emitPurchaseForSourceProducts(invoice({ user: { id: 'u1' } }))).resolves.toEqual([]);
    await expect(emitPurchaseForSourceProducts(invoice({ user: { id: 'u1', acquisition: null } }))).resolves.toEqual(
      []
    );
    await expect(emitPurchaseForSourceProducts(invoice({ user: null }))).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('skips a synthetic user', async () => {
    await expect(
      emitPurchaseForSourceProducts(
        invoice({ user: { id: 'u1', isSynthetic: true, acquisition: { firstTouch: { source: 'widgets' } } } })
      )
    ).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it.each([0, -500, null, undefined, Number.NaN])('sends nothing when the amount collected is %s', async amount => {
    await expect(emitPurchaseForSourceProducts(invoice({ amountMinor: amount }))).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('sends nothing without a payment id or a currency', async () => {
    await expect(emitPurchaseForSourceProducts(invoice({ paymentId: '' }))).resolves.toEqual([]);
    await expect(emitPurchaseForSourceProducts(invoice({ currency: null }))).resolves.toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws when the emitter rejects or the key lookup throws', async () => {
    mockEmit.mockRejectedValue(new Error('down'));
    await expect(emitPurchaseForSourceProducts(invoice())).resolves.toEqual(['widgets']);

    mockKeyFor.mockImplementation(() => {
      throw new Error('bad config');
    });
    await expect(emitPurchaseForSourceProducts(invoice())).resolves.toEqual([]);
  });
});

describe('stableEventId', () => {
  it('is a UUID-shaped id, the same for the same parts and different otherwise', () => {
    const a = stableEventId('signup', 'widgets', 'u1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventId('signup', 'widgets', 'u1')).toBe(a);
    expect(stableEventId('signup', 'widgets', 'u2')).not.toBe(a);
  });
});

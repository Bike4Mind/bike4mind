// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Boots a real mongod: crediting an account once is a property of the conditional update, which
// only a real server can show.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { config, productEvents } = vi.hoisted(() => ({
  config: { OVERWATCH_PSEUDONYM_SALT: 'e2e-salt' } as Record<string, string | undefined>,
  productEvents: [] as Array<{ productId: string; event: string; utm?: unknown; metadata?: Record<string, unknown> }>,
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config, isDevelopment: () => false }));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>()),
  ingestKeyFor: (productId: string) =>
    ['bike4mind', 'reading-app', 'other-app'].includes(productId) ? 'key' : undefined,
  emitProductEvent: async (event: (typeof productEvents)[number]) => {
    productEvents.push(event);
  },
}));

import { User } from '@bike4mind/database';
import type { IUserAcquisition } from '@bike4mind/common';
import { emitPurchaseEvents } from '@bike4mind/server-utils/analytics/signupEvents';
import { creditOAuthSignup, OAUTH_SIGNUP_WINDOW_MS } from './oauthSignupCredit';

const CLIENT = { clientId: 'reading-app-client', overwatchProductId: 'reading-app' };
const CONSENTED = { headers: { cookie: 'b4m_consent=granted' } };

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  productEvents.length = 0;
  await User.deleteMany({});
});

/** A new account, with `over` written straight to the stored document (createdAt, flags, touches). */
async function account(over: Record<string, unknown> = {}): Promise<string> {
  const user = await User.create({
    name: 'Persona',
    username: `persona-oauth-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
  });
  if (Object.keys(over).length > 0) await User.collection.updateOne({ _id: user._id }, { $set: over });
  return user.id;
}

const acquisitionOf = async (id: string) =>
  (await User.findById(id).lean<{ acquisition?: IUserAcquisition }>())?.acquisition;

const signups = () => productEvents.filter(e => e.event === 'signup').map(e => [e.productId, e.metadata?.touch]);

describe('creditOAuthSignup', () => {
  it('records the client product on a new account and credits its signup, once', async () => {
    const id = await account();

    await expect(creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT })).resolves.toEqual(['reading-app']);
    await expect(creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT })).resolves.toEqual([]);

    const acquisition = await acquisitionOf(id);
    expect(acquisition?.oauthTouch).toEqual({ source: 'reading-app', medium: 'oauth', content: 'reading-app-client' });
    expect(acquisition?.signupMethod).toBe('otc');
    expect(acquisition?.capturedAt).toBeInstanceOf(Date);
    expect(signups()).toEqual([['reading-app', 'oauth']]);

    // The stored acquisition satisfies the schema, so a later save of the account still validates.
    const doc = await User.findById(id);
    doc!.name = 'Persona renamed';
    await expect(doc!.save()).resolves.toBeTruthy();
  });

  it('credits the payments the account makes later to the same product', async () => {
    const id = await account();
    await creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT });
    productEvents.length = 0;

    await emitPurchaseEvents({
      user: await User.findById(id),
      paymentId: 'in_1',
      kind: 'subscription',
      amountMinor: 3000,
      currency: 'usd',
      billingReason: 'subscription_create',
    });

    expect(productEvents.map(e => [e.productId, e.event, e.metadata?.touch, e.metadata?.value])).toEqual([
      ['bike4mind', 'purchase', undefined, 30],
      ['reading-app', 'purchase', 'oauth', 30],
    ]);
  });

  it('keeps the campaign touches and method an account already has', async () => {
    const capturedAt = new Date('2026-01-01T00:00:00Z');
    const id = await account({
      acquisition: { lastTouch: { source: 'newsletter' }, signupMethod: 'google', capturedAt },
    });

    await creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT });

    expect(await acquisitionOf(id)).toEqual({
      lastTouch: { source: 'newsletter' },
      oauthTouch: { source: 'reading-app', medium: 'oauth', content: 'reading-app-client' },
      signupMethod: 'google',
      capturedAt,
    });
    expect(productEvents.map(e => e.metadata?.method)).toEqual(['google']);
  });

  it('takes the method of an account with no stored acquisition from its first sign-in provider', async () => {
    const id = await account({ authProviders: [{ id: 'g-1', strategy: 'google' }] });
    await creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT });
    expect((await acquisitionOf(id))?.signupMethod).toBe('google');
  });

  it('credits nothing for an account created before the window', async () => {
    const id = await account({ createdAt: new Date(Date.now() - OAUTH_SIGNUP_WINDOW_MS - 60_000) });
    await expect(creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT })).resolves.toEqual([]);
    expect(await acquisitionOf(id)).toBeUndefined();
    expect(productEvents).toEqual([]);
  });

  it.each([
    ['no consent decision', {}],
    ['a declined consent', { cookie: 'b4m_consent=denied' }],
  ])('credits nothing with %s', async (_name, headers) => {
    const id = await account();
    await expect(creditOAuthSignup({ req: { headers }, userId: id, client: CLIENT })).resolves.toEqual([]);
    expect(await acquisitionOf(id)).toBeUndefined();
    expect(productEvents).toEqual([]);
  });

  it('credits nothing for a client with no Overwatch product', async () => {
    const id = await account();
    await expect(
      creditOAuthSignup({ req: CONSENTED, userId: id, client: { clientId: 'plain-client' } })
    ).resolves.toEqual([]);
    expect(await acquisitionOf(id)).toBeUndefined();
  });

  it('credits nothing for a synthetic account', async () => {
    const id = await account({ isSynthetic: true });
    await expect(creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT })).resolves.toEqual([]);
    expect(productEvents).toEqual([]);
  });

  it('credits one client when two codes for different clients are issued at once', async () => {
    const id = await account();
    const other = { clientId: 'other-app-client', overwatchProductId: 'other-app' };

    const results = await Promise.all([
      creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT }),
      creditOAuthSignup({ req: CONSENTED, userId: id, client: other }),
    ]);

    expect(results.filter(r => r.length > 0)).toHaveLength(1);
    expect(signups()).toHaveLength(1);
    expect((await acquisitionOf(id))?.oauthTouch?.source).toBe(signups()[0][0]);
  });

  it('credits one client for an account with campaign touches when two codes are issued at once', async () => {
    const id = await account({
      acquisition: { lastTouch: { source: 'newsletter' }, signupMethod: 'otc', capturedAt: new Date() },
    });
    const other = { clientId: 'other-app-client', overwatchProductId: 'other-app' };

    await Promise.all([
      creditOAuthSignup({ req: CONSENTED, userId: id, client: CLIENT }),
      creditOAuthSignup({ req: CONSENTED, userId: id, client: other }),
    ]);

    expect(signups()).toHaveLength(1);
    expect((await acquisitionOf(id))?.oauthTouch?.source).toBe(signups()[0][0]);
  });

  it('never throws, so a failed lookup cannot fail the code it rides on', async () => {
    await expect(creditOAuthSignup({ req: CONSENTED, userId: 'not-an-object-id', client: CLIENT })).resolves.toEqual(
      []
    );
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { UserApiKey } from '../auth/UserApiKeyModel';
import { CreditTransaction, creditTransactionRepository } from './CreditTransactionModel';
import { clearExchangeAttributionCache, warmExchangeAttribution } from './exchangeAttribution';
import { Logger } from '@bike4mind/observability';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await CreditTransaction.createCollection();
  await UserApiKey.createCollection();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(() => {
  clearExchangeAttributionCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await CreditTransaction.deleteMany({});
  await UserApiKey.collection.deleteMany({});
});

const USER = 'user-1';

const insertKey = async (metadata: Record<string, unknown>) => {
  const id = new mongoose.Types.ObjectId();
  await UserApiKey.collection.insertOne({ _id: id, userId: USER, metadata });
  return String(id);
};

const exchangeKey = (payerStanding?: 'paid' | 'unpaid') =>
  insertKey({
    createdFrom: 'oauth-exchange',
    oauthClientId: 'app-1',
    ...(payerStanding ? { payerStanding } : {}),
  });

const charge = (apiKeyId: string | undefined, ownerType: CreditHolderType, ownerId: string) =>
  creditTransactionRepository.createTransaction('text_generation_usage', {
    ownerId,
    ownerType,
    credits: 5,
    model: 'model-alpha',
    inputTokens: 1,
    outputTokens: 1,
    ...(apiKeyId ? { apiKeyId } : {}),
  } as never);

describe('createTransaction exchange attribution', () => {
  it('stamps app and standing when the key owner pays', async () => {
    const key = await exchangeKey('paid');
    const tx = await charge(key, CreditHolderType.User, USER);
    expect(tx).toMatchObject({ oauthClientId: 'app-1', payerStanding: 'paid' });
  });

  it('stamps only the app when an organization pays', async () => {
    const key = await exchangeKey('paid');
    const tx = await charge(key, CreditHolderType.Organization, 'org-1');
    expect(tx?.oauthClientId).toBe('app-1');
    expect(tx?.payerStanding).toBeUndefined();
  });

  it('stamps no standing when the payer is a different user', async () => {
    const key = await exchangeKey('unpaid');
    const tx = await charge(key, CreditHolderType.User, 'someone-else');
    expect(tx?.oauthClientId).toBe('app-1');
    expect(tx?.payerStanding).toBeUndefined();
  });

  it('stamps neither for a personal key', async () => {
    const key = await insertKey({ createdFrom: 'user' });
    const tx = await charge(key, CreditHolderType.User, USER);
    expect(tx?.oauthClientId).toBeUndefined();
    expect(tx?.payerStanding).toBeUndefined();
  });

  it('does no lookup without an apiKeyId', async () => {
    const spy = vi.spyOn(UserApiKey, 'findById');
    const tx = await charge(undefined, CreditHolderType.User, USER);
    expect(spy).not.toHaveBeenCalled();
    expect(tx?.oauthClientId).toBeUndefined();
  });

  it('leaves the fields unset and still writes when the lookup fails', async () => {
    const key = await exchangeKey('paid');
    vi.spyOn(UserApiKey, 'findById').mockImplementation(() => {
      throw new Error('db down');
    });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const tx = await charge(key, CreditHolderType.User, USER);
    expect(tx).not.toBeNull();
    expect(tx?.oauthClientId).toBeUndefined();
    expect(tx?.payerStanding).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('key read failed'), { apiKeyId: key });
  });

  it('never reads inside a transaction on a cold cache', async () => {
    const key = await exchangeKey('paid');
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(UserApiKey, 'findById');
    await withTransaction(async () => {
      await charge(key, CreditHolderType.User, USER);
    });
    expect(spy).not.toHaveBeenCalled();
    const row = await CreditTransaction.findOne({}).lean();
    expect(row?.oauthClientId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold cache inside a transaction'), { apiKeyId: key });
  });

  it('stamps inside a transaction once the cache is warmed', async () => {
    const key = await exchangeKey('paid');
    await warmExchangeAttribution(key);
    await withTransaction(async () => {
      await charge(key, CreditHolderType.User, USER);
    });
    const row = await CreditTransaction.findOne({}).lean();
    expect(row).toMatchObject({ oauthClientId: 'app-1', payerStanding: 'paid' });
  });
});

describe('credit transaction schema round trip', () => {
  it('persists oauthClientId and payerStanding and rejects an unknown standing', async () => {
    const saved = await CreditTransaction.create({
      type: 'text_generation_usage',
      ownerId: USER,
      ownerType: CreditHolderType.User,
      credits: 1,
      oauthClientId: 'app-2',
      payerStanding: 'unpaid',
    } as never);
    const row = await CreditTransaction.findById(saved.id).lean();
    expect(row).toMatchObject({ oauthClientId: 'app-2', payerStanding: 'unpaid' });
    await expect(
      CreditTransaction.create({
        type: 'text_generation_usage',
        ownerId: USER,
        ownerType: CreditHolderType.User,
        credits: 1,
        payerStanding: 'bogus',
      } as never)
    ).rejects.toThrow();
  });
});

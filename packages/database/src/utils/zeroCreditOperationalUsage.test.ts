import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IUsageEventInput } from '@bike4mind/common';
import { User } from '../models/auth/UserModel';
import { Organization } from '../models/infra/admin/OrganizationModel';
import { UsageEvent } from '../models/billing/UsageEventModel';
import { createBoundedZeroCreditOperationalUsageStore } from './zeroCreditOperationalUsage';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const event: IUsageEventInput = {
  requestId: 'completion-test',
  userId,
  ownerId: organizationId,
  ownerType: CreditHolderType.Organization,
  feature: 'operations',
  provider: 'bedrock',
  model: 'test-model',
  inputTokens: 10,
  outputTokens: 3,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  creditsCharged: 0,
  status: 'ok',
  source: 'system',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('bounded operational usage persistence', () => {
  const connection = User.db;
  const originalDb = connection.db;
  const findUser = vi.fn();
  const findOrganization = vi.fn();
  const insert = vi.fn();
  const collection = vi.fn();
  const store = () => createBoundedZeroCreditOperationalUsageStore({ lookupTimeoutMS: 10_000, writeTimeoutMS: 20_000 });

  beforeEach(() => {
    vi.spyOn(connection, 'readyState', 'get').mockReturnValue(1);
    findUser.mockReset().mockResolvedValue({ _id: new mongoose.Types.ObjectId(userId) });
    findOrganization.mockReset().mockResolvedValue({ _id: new mongoose.Types.ObjectId(organizationId) });
    insert.mockReset().mockResolvedValue({ acknowledged: true });
    collection.mockReset().mockImplementation((name: string) => {
      if (name === User.collection.name) return { findOne: findUser };
      if (name === Organization.collection.name) return { findOne: findOrganization };
      if (name === UsageEvent.collection.name) return { insertOne: insert };
      throw new Error('Unexpected collection');
    });
    connection.db = { collection } as unknown as typeof connection.db;
  });

  afterEach(() => {
    connection.db = originalDb;
    vi.restoreAllMocks();
  });

  it('uses bounded identity projections and preserves the organization tombstone filter', async () => {
    const persistence = store();
    const [user, organization] = await Promise.all([
      persistence.findUserById(userId),
      persistence.findOrganizationById(organizationId),
    ]);
    expect(user).toEqual({ id: userId });
    expect(organization).toEqual({ id: organizationId });
    expect(findUser).toHaveBeenCalledExactlyOnceWith(
      { _id: new mongoose.Types.ObjectId(userId) },
      { projection: { _id: 1 }, timeoutMS: 10_000 }
    );
    expect(findOrganization).toHaveBeenCalledExactlyOnceWith(
      { _id: new mongoose.Types.ObjectId(organizationId), deletedAt: null },
      { projection: { _id: 1 }, timeoutMS: 10_000 }
    );
  });

  it('returns null for a missing actor or invalid identity without querying invalid ids', async () => {
    findUser.mockResolvedValue(null);
    findOrganization.mockResolvedValue(null);
    const persistence = store();
    expect(await persistence.findUserById(userId)).toBeNull();
    expect(await persistence.findOrganizationById(organizationId)).toBeNull();
    findUser.mockClear();
    findOrganization.mockClear();
    expect(await persistence.findUserById('not-an-id')).toBeNull();
    expect(await persistence.findOrganizationById('not-an-id')).toBeNull();
    expect(findUser).not.toHaveBeenCalled();
    expect(findOrganization).not.toHaveBeenCalled();
  });

  it('keeps concurrent owner reads pending until their native operations settle', async () => {
    const pendingUser = deferred<{ _id: mongoose.Types.ObjectId }>();
    const pendingOrganization = deferred<{ _id: mongoose.Types.ObjectId }>();
    findUser.mockReturnValue(pendingUser.promise);
    findOrganization.mockReturnValue(pendingOrganization.promise);
    const persistence = store();
    const result = Promise.all([persistence.findUserById(userId), persistence.findOrganizationById(organizationId)]);
    const settled = vi.fn();
    void result.then(settled);
    expect(findUser).toHaveBeenCalledTimes(1);
    expect(findOrganization).toHaveBeenCalledTimes(1);
    pendingUser.resolve({ _id: new mongoose.Types.ObjectId(userId) });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    pendingOrganization.resolve({ _id: new mongoose.Types.ObjectId(organizationId) });
    await result;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('writes a real validated schema document with defaults, timestamps and no virtual fields', async () => {
    const { status: _status, inputTokens: _input, ...withoutDefaults } = event;
    const result = await store().usageEvents.record(withoutDefaults as IUsageEventInput);
    const [row, options] = insert.mock.calls[0];
    expect(options).toEqual({ timeoutMS: 20_000 });
    expect(row).toMatchObject({ requestId: event.requestId, inputTokens: 0, status: 'ok', creditsCharged: 0, __v: 0 });
    expect(row._id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toEqual(row.createdAt);
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('fundingBreakdown');
    expect(result.id).toBe(row._id.toString());
    expect(collection).toHaveBeenCalledExactlyOnceWith(UsageEvent.collection.name);
    expect(findUser).not.toHaveBeenCalled();
    expect(findOrganization).not.toHaveBeenCalled();
  });

  it.each([
    { ...event, ownerType: 'invalid' },
    { ...event, requestId: undefined },
    { ...event, costUsd: 'invalid' },
  ])('rejects schema-invalid events before any native write', async invalid => {
    await expect(store().usageEvents.record(invalid as IUsageEventInput)).rejects.toBeInstanceOf(
      mongoose.Error.ValidationError
    );
    expect(insert).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
  });

  it.each([1, -1, NaN, undefined])('rejects nonzero or missing credit charges: %s', async creditsCharged => {
    await expect(store().usageEvents.record({ ...event, creditsCharged } as IUsageEventInput)).rejects.toThrow(
      'zero-credit'
    );
    expect(insert).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid operation timeout %s', timeout => {
    expect(() =>
      createBoundedZeroCreditOperationalUsageStore({ lookupTimeoutMS: timeout, writeTimeoutMS: 20_000 })
    ).toThrow(RangeError);
    expect(() =>
      createBoundedZeroCreditOperationalUsageStore({ lookupTimeoutMS: 10_000, writeTimeoutMS: timeout })
    ).toThrow(RangeError);
    expect(collection).not.toHaveBeenCalled();
  });

  it('fails promptly when disconnected instead of entering Mongoose buffering or connecting', async () => {
    vi.spyOn(connection, 'readyState', 'get').mockReturnValue(0);
    const persistence = store();
    await expect(persistence.findUserById(userId)).rejects.toThrow('established database connection');
    await expect(persistence.findOrganizationById(organizationId)).rejects.toThrow('established database connection');
    await expect(persistence.usageEvents.record(event)).rejects.toThrow('established database connection');
    expect(collection).not.toHaveBeenCalled();
  });

  it('rejects an absent native Db even if the Mongoose state reports connected', async () => {
    connection.db = undefined;
    await expect(store().usageEvents.record(event)).rejects.toThrow('established database connection');
    expect(collection).not.toHaveBeenCalled();
  });

  it('awaits an original insert and propagates its error without retrying an ambiguous write', async () => {
    const write = deferred<never>();
    insert.mockReturnValue(write.promise);
    const result = store().usageEvents.record(event);
    const settled = vi.fn();
    void result.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const error = new Error('native operation timed out');
    write.reject(error);
    await expect(result).rejects.toBe(error);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('preserves native read errors', async () => {
    const error = new Error('native read timed out');
    findUser.mockRejectedValue(error);
    await expect(store().findUserById(userId)).rejects.toBe(error);
  });
});

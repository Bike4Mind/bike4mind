import { afterEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

describe('organization storage allocation', () => {
  setupMongoTest();
  afterEach(() => vi.restoreAllMocks());

  const seed = (fields: Record<string, unknown> = {}) =>
    Organization.create({ name: 'org', userId: 'owner', users: [], groups: [], ...fields });
  const limits = async (id: string) => {
    const row = await Organization.findById(id).lean();
    return {
      storageLimit: row?.storageLimit,
      storageLimitOverride: row?.storageLimitOverride,
      planStorageLimit: row?.planStorageLimit,
    };
  };

  it.each([undefined, null, 0, 2500, 10_000])('preserves the legacy manual limit %s', async storageLimit => {
    const org = await seed({ storageLimit });
    await organizationRepository.setPlanStorageLimit(org.id, 50_000);
    expect(await limits(org.id)).toEqual({
      storageLimit: storageLimit ?? 50_000,
      storageLimitOverride: storageLimit ?? null,
      planStorageLimit: 50_000,
    });
  });

  it('updates the plan repeatedly without capturing the old plan as a manual limit', async () => {
    const org = await seed();
    await organizationRepository.setPlanStorageLimit(org.id, 50_000);
    await organizationRepository.setPlanStorageLimit(org.id, 20_000);
    expect(await limits(org.id)).toEqual({
      storageLimit: 20_000,
      storageLimitOverride: null,
      planStorageLimit: 20_000,
    });
  });

  it.each([
    { fields: { planStorageLimit: null, storageLimit: 7500 }, override: null },
    { fields: { planStorageLimit: 20_000, storageLimit: 7500 }, override: null },
    { fields: { planStorageLimit: 0, storageLimit: 7500 }, override: null },
    { fields: { storageLimitOverride: null, storageLimit: 7500 }, override: null },
    { fields: { storageLimitOverride: 0, planStorageLimit: null, storageLimit: 7500 }, override: 0 },
    { fields: { storageLimitOverride: 1234, planStorageLimit: 20_000, storageLimit: 7500 }, override: 1234 },
  ])('preserves explicit quota state $fields', async ({ fields, override }) => {
    const org = await seed(fields);
    expect(await organizationRepository.setPlanStorageLimit(org.id, 50_000)).toBe(true);
    expect(await limits(org.id)).toEqual({
      storageLimit: override ?? 50_000,
      storageLimitOverride: override,
      planStorageLimit: 50_000,
    });
  });

  it('creates a real version fence for legacy rows and equal-value writes', async () => {
    const id = new mongoose.Types.ObjectId();
    await Organization.collection.insertOne({ _id: id, name: 'legacy', userId: 'owner', storageLimit: 0 });
    await organizationRepository.setPlanStorageLimit(id.toString(), 50_000);
    expect((await Organization.collection.findOne({ _id: id }))?.__v).toBe(1);
    await organizationRepository.setPlanStorageLimit(id.toString(), 50_000);
    expect((await Organization.collection.findOne({ _id: id }))?.__v).toBe(2);
    expect(await limits(id.toString())).toEqual({ storageLimit: 0, storageLimitOverride: 0, planStorageLimit: 50_000 });
  });

  it('validates new quota values without partially updating the stored allocation', async () => {
    const org = await seed({ storageLimit: 7500 });
    await expect(organizationRepository.setStorageLimitOverride(org.id, -1)).rejects.toThrow();
    await expect(organizationRepository.setPlanStorageLimit(org.id, -1)).rejects.toThrow();
    expect(await limits(org.id)).toEqual({
      storageLimit: 7500,
      storageLimitOverride: undefined,
      planStorageLimit: undefined,
    });
  });

  it('does not change a soft-deleted organization', async () => {
    const org = await seed({ storageLimit: 7500 });
    await Organization.deleteOne({ _id: org.id });
    expect(await organizationRepository.setPlanStorageLimit(org.id, 50_000)).toBe(false);
    expect(await organizationRepository.setStorageLimitOverride(org.id, 0)).toBeNull();
    expect((await Organization.collection.findOne({ _id: org._id }))?.storageLimit).toBe(7500);
  });

  it('keeps an explicit zero override through plan changes and reveals the latest plan when cleared', async () => {
    const org = await seed();
    await organizationRepository.setStorageLimitOverride(org.id, 0);
    await organizationRepository.setPlanStorageLimit(org.id, 50_000);
    expect(await limits(org.id)).toEqual({ storageLimit: 0, storageLimitOverride: 0, planStorageLimit: 50_000 });
    await organizationRepository.setStorageLimitOverride(org.id, null);
    expect(await limits(org.id)).toEqual({
      storageLimit: 50_000,
      storageLimitOverride: null,
      planStorageLimit: 50_000,
    });
  });

  it('clears a legacy limit to the default without reclassifying it on the next plan write', async () => {
    const org = await seed({ storageLimit: 7500 });
    await organizationRepository.setStorageLimitOverride(org.id, null);
    expect((await limits(org.id)).storageLimit).toBe(10_000);
    await organizationRepository.setPlanStorageLimit(org.id, 50_000);
    expect((await limits(org.id)).storageLimit).toBe(50_000);
  });

  it('serializes racing admin and plan writes without losing the override', async () => {
    const org = await seed();
    await Promise.all([
      organizationRepository.setStorageLimitOverride(org.id, 1234),
      organizationRepository.setPlanStorageLimit(org.id, 50_000),
    ]);
    expect(await limits(org.id)).toEqual({ storageLimit: 1234, storageLimitOverride: 1234, planStorageLimit: 50_000 });
  });

  it('returns false for an unknown or malformed owner', async () => {
    expect(await organizationRepository.setPlanStorageLimit(String(new mongoose.Types.ObjectId()), 5000)).toBe(false);
    expect(await organizationRepository.setPlanStorageLimit('invalid', 5000)).toBe(false);
  });

  it.each(['plan', 'override'])('writes the %s limit on a backend that rejects pipeline updates', async operation => {
    const org = await seed();
    const update = Organization.collection.updateOne.bind(Organization.collection);
    const findAndUpdate = Organization.collection.findOneAndUpdate.bind(Organization.collection);
    vi.spyOn(Organization.collection, 'updateOne').mockImplementation(async (...args) => {
      if (Array.isArray(args[1])) throw new Error('Backend does not support pipeline updates');
      return update(...args);
    });
    vi.spyOn(Organization.collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (Array.isArray(args[1])) throw new Error('Backend does not support pipeline updates');
      return findAndUpdate(...args);
    });
    if (operation === 'plan') {
      await expect(organizationRepository.setPlanStorageLimit(org.id, 50_000)).resolves.toBe(true);
      expect((await limits(org.id)).planStorageLimit).toBe(50_000);
      return;
    }
    await expect(organizationRepository.setStorageLimitOverride(org.id, 1234)).resolves.toMatchObject({
      storageLimit: 1234,
      storageLimitOverride: 1234,
    });
    expect((await limits(org.id)).storageLimit).toBe(1234);
  });
});

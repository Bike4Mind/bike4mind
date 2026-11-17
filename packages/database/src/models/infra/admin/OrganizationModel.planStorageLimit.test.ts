import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

describe('organization storage allocation', () => {
  setupMongoTest();

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
});

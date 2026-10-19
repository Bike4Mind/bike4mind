import { describe, it, expect } from 'vitest';
import { Organization, organizationRepository } from './OrganizationModel';
import { setupMongoTest } from '../../../__test__/utils';

const makeOrg = (extra: Record<string, unknown> = {}) =>
  Organization.create({ name: 'org', userId: 'owner', users: [], groups: [], ...extra });

const storedSize = async (id: unknown) =>
  (await Organization.findById(id).lean<{ currentStorageSize?: number }>())?.currentStorageSize;

describe('OrganizationRepository.incrementCurrentStorage', () => {
  setupMongoTest();

  it('treats a missing counter as 0', async () => {
    const org = await makeOrg();
    await organizationRepository.incrementCurrentStorage(String(org._id), 500);
    expect(await storedSize(org._id)).toBe(500);
  });

  it('accumulates and refunds', async () => {
    const org = await makeOrg({ currentStorageSize: 1000 });
    await organizationRepository.incrementCurrentStorage(String(org._id), 250);
    await organizationRepository.incrementCurrentStorage(String(org._id), -400);
    expect(await storedSize(org._id)).toBe(850);
  });

  it('floors an over-refund at 0', async () => {
    const org = await makeOrg({ currentStorageSize: 100 });
    await organizationRepository.incrementCurrentStorage(String(org._id), -500);
    expect(await storedSize(org._id)).toBe(0);
  });

  it('persists storageLimit, which the schema used to drop', async () => {
    const org = await makeOrg({ storageLimit: 5000 });
    expect((await Organization.findById(org._id).lean<{ storageLimit?: number }>())?.storageLimit).toBe(5000);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Organization.deleteMany({});
});

const seed = async (currentCredits: number) => {
  const org = await Organization.create({ name: 'Credits fixture', userId: 'org-owner', users: [], groups: [] });
  await Organization.collection.updateOne({ _id: org._id }, { $set: { currentCredits } });
  return String(org._id);
};
const balanceOf = async (id: string) =>
  (await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.currentCredits;

describe('OrganizationRepository.decrementCreditsFloored', () => {
  it('debits in full when the balance covers it', async () => {
    const id = await seed(100);
    expect(await organizationRepository.decrementCreditsFloored(id, 40)).toBe(40);
    expect(await balanceOf(id)).toBe(60);
  });

  it('takes the balance to zero, never below, and reports what it took', async () => {
    const id = await seed(30);
    expect(await organizationRepository.decrementCreditsFloored(id, 50)).toBe(30);
    expect(await balanceOf(id)).toBe(0);
  });

  it('takes nothing from a balance already at or below zero', async () => {
    const id = await seed(-5);
    expect(await organizationRepository.decrementCreditsFloored(id, 10)).toBe(0);
    expect(await balanceOf(id)).toBe(-5);
  });

  it('never overdraws under concurrent debits', async () => {
    const id = await seed(100);
    const taken = await Promise.all(
      Array.from({ length: 5 }, () => organizationRepository.decrementCreditsFloored(id, 30))
    );
    expect(taken.reduce((a, b) => a + b, 0)).toBe(100);
    expect(await balanceOf(id)).toBe(0);
  });

  it('resolves 0 for a missing organization', async () => {
    expect(await organizationRepository.decrementCreditsFloored(String(new mongoose.Types.ObjectId()), 10)).toBe(0);
  });
});

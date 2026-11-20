import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

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
  await User.deleteMany({});
});

const seed = async (currentCredits: number) => {
  const user = await User.create({ username: `u-${new mongoose.Types.ObjectId()}`, name: 'Credits fixture' });
  await User.collection.updateOne({ _id: user._id }, { $set: { currentCredits } });
  return String(user._id);
};
const balanceOf = async (id: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.currentCredits;

describe('UserRepository.decrementCreditsFloored', () => {
  it('debits in full when the balance covers it', async () => {
    const id = await seed(100);
    expect(await userRepository.decrementCreditsFloored(id, 40)).toBe(40);
    expect(await balanceOf(id)).toBe(60);
  });

  it('takes the balance to zero, never below, and reports what it took', async () => {
    const id = await seed(30);
    expect(await userRepository.decrementCreditsFloored(id, 50)).toBe(30);
    expect(await balanceOf(id)).toBe(0);
  });

  it('takes nothing from a balance already at or below zero', async () => {
    const id = await seed(-5);
    expect(await userRepository.decrementCreditsFloored(id, 10)).toBe(0);
    expect(await balanceOf(id)).toBe(-5);
  });

  it('never overdraws under concurrent debits', async () => {
    const id = await seed(100);
    const taken = await Promise.all(Array.from({ length: 5 }, () => userRepository.decrementCreditsFloored(id, 30)));
    expect(taken.reduce((a, b) => a + b, 0)).toBe(100);
    expect(await balanceOf(id)).toBe(0);
  });

  it('resolves 0 for a missing user', async () => {
    expect(await userRepository.decrementCreditsFloored(String(new mongoose.Types.ObjectId()), 10)).toBe(0);
  });
});

describe('UserRepository.decrementCreditsIfCovered', () => {
  it('debits when the balance covers the whole amount', async () => {
    const id = await seed(40);
    expect(await userRepository.decrementCreditsIfCovered(id, 40)).toBe(true);
    expect(await balanceOf(id)).toBe(0);
  });

  it('leaves a short balance untouched', async () => {
    const id = await seed(30);
    expect(await userRepository.decrementCreditsIfCovered(id, 40)).toBe(false);
    expect(await balanceOf(id)).toBe(30);
  });

  it('lets only covered debits through under concurrency', async () => {
    const id = await seed(100);
    const taken = await Promise.all(Array.from({ length: 5 }, () => userRepository.decrementCreditsIfCovered(id, 30)));
    expect(taken.filter(Boolean)).toHaveLength(3);
    expect(await balanceOf(id)).toBe(10);
  });

  it('resolves false for a missing user', async () => {
    expect(await userRepository.decrementCreditsIfCovered(String(new mongoose.Types.ObjectId()), 10)).toBe(false);
  });
});

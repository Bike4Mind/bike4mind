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

const seed = async (counter?: number) => {
  const user = await User.create({ username: `u-${new mongoose.Types.ObjectId()}`, name: 'Counter fixture' });
  await User.collection.updateOne(
    { _id: user._id },
    counter === undefined ? { $unset: { currentStorageSize: '' } } : { $set: { currentStorageSize: counter } }
  );
  return String(user._id);
};
const counterOf = async (id: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.currentStorageSize;

describe('UserRepository.setCurrentStorageIfUnchanged', () => {
  it('writes when the counter still holds the expected value', async () => {
    const id = await seed(1000);
    expect(await userRepository.setCurrentStorageIfUnchanged(id, 1000, 400)).toBe(true);
    expect(await counterOf(id)).toBe(400);
  });

  it('refuses when a concurrent adjustment moved the counter', async () => {
    const id = await seed(1000);
    await userRepository.incrementCurrentStorage(id, 50);
    expect(await userRepository.setCurrentStorageIfUnchanged(id, 1000, 400)).toBe(false);
    expect(await counterOf(id)).toBe(1050);
  });

  it('treats a missing counter as 0', async () => {
    const id = await seed(undefined);
    expect(await userRepository.setCurrentStorageIfUnchanged(id, 0, 300)).toBe(true);
    expect(await counterOf(id)).toBe(300);
  });
});

describe('UserRepository.findCurrentStorageSize', () => {
  it('reads the counter, a missing one as 0, and null for an unknown or malformed id', async () => {
    expect(await userRepository.findCurrentStorageSize(await seed(10))).toBe(10);
    expect(await userRepository.findCurrentStorageSize(await seed(undefined))).toBe(0);
    expect(await userRepository.findCurrentStorageSize(String(new mongoose.Types.ObjectId()))).toBeNull();
    expect(await userRepository.findCurrentStorageSize('not-an-id')).toBeNull();
  });
});

describe('UserRepository.listUserIdsAfter', () => {
  it('pages users in _id order', async () => {
    const ids = [await seed(10), await seed(20), await seed(30)].sort();
    const first = await userRepository.listUserIdsAfter(null, 2);
    expect(first).toEqual(ids.slice(0, 2));
    expect(await userRepository.listUserIdsAfter(first[1], 2)).toEqual(ids.slice(2));
  });
});

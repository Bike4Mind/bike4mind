import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Session } from '../SessionModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Session.deleteMany({});
});

const base = () => ({ name: 'n', userId: 'u1', firstCreated: new Date(), lastUpdated: new Date() });

describe('Session.includeLibraryFiles', () => {
  it('persists false rather than dropping it', async () => {
    const { _id } = await Session.create({ ...base(), includeLibraryFiles: false });
    const read = await Session.findById(_id).lean();
    expect(read?.includeLibraryFiles).toBe(false);
  });

  // A default would erase the "never chosen" state the effective value falls back from.
  it('hydrates undefined when never set', async () => {
    const { _id } = await Session.create(base());
    const read = await Session.findById(_id);
    expect(read?.includeLibraryFiles).toBeUndefined();
  });
});

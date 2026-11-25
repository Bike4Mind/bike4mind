import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Session.collection.deleteMany({});
});

const insertSession = (userId: string, fields: Record<string, unknown> = {}) =>
  Session.create({ name: 'n', userId, lastUpdated: new Date(), firstCreated: new Date(), ...fields });

describe('sessionRepository.findSessionIdsByUserId', () => {
  it("lists the ids of the owner's live sessions only", async () => {
    const first = await insertSession('owner');
    const second = await insertSession('owner');
    await insertSession('someone-else');
    await insertSession('owner', { deletedAt: new Date() });

    const ids = await sessionRepository.findSessionIdsByUserId('owner');

    expect(ids.sort()).toEqual([first.id, second.id].sort());
  });
});

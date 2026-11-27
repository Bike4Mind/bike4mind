import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
});

const NOW = new Date('2026-11-20T15:00:00.000Z');

const insertUser = async (fields: Record<string, unknown> = {}) => {
  const { insertedId } = await User.collection.insertOne({
    username: 'u',
    email: 'u@example.com',
    preferences: null,
    ...fields,
  });
  return insertedId.toString();
};
const raw = (userId: string) => User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });

describe('userRepository interruption feedback', () => {
  it('reads as empty when unset or when the user does not exist', async () => {
    const userId = await insertUser();
    expect(await userRepository.getInterruptionFeedback(userId)).toEqual({});
    expect(await userRepository.getInterruptionFeedback(new mongoose.Types.ObjectId().toString())).toEqual({});
  });

  it('persists a patch on a user whose preferences are null', async () => {
    const userId = await insertUser();
    expect(await userRepository.setInterruptionFeedback(userId, { agent_completed: true })).toEqual({
      agent_completed: true,
    });
    expect((await raw(userId))?.preferences?.interruptionFeedback).toEqual({ agent_completed: true });
    expect(await userRepository.getInterruptionFeedback(userId)).toEqual({ agent_completed: true });
  });

  it('persists a patch when the stored feedback is null', async () => {
    const userId = await insertUser({ preferences: { interruptionFeedback: null } });
    expect(await userRepository.setInterruptionFeedback(userId, { agent_failed: true })).toEqual({
      agent_failed: true,
    });
  });

  it('keeps the other category on a partial patch', async () => {
    const userId = await insertUser();
    await userRepository.setInterruptionFeedback(userId, { agent_completed: true });
    expect(await userRepository.setInterruptionFeedback(userId, { agent_failed: true })).toEqual({
      agent_completed: true,
      agent_failed: true,
    });
  });

  it('persists false and treats an empty patch as a no-op', async () => {
    const userId = await insertUser({ preferences: { interruptionFeedback: { agent_completed: true } } });
    expect(await userRepository.setInterruptionFeedback(userId, { agent_completed: false })).toEqual({
      agent_completed: false,
    });
    expect(await userRepository.setInterruptionFeedback(userId, {})).toEqual({ agent_completed: false });
  });

  it('keeps the other preferences when it writes', async () => {
    const userId = await insertUser({ preferences: { pushNotifications: { brief_ready: false } } });
    await userRepository.setInterruptionFeedback(userId, { agent_failed: true });
    expect((await raw(userId))?.preferences?.pushNotifications).toEqual({ brief_ready: false });
  });

  it('survives a busy-block sync turning the opt-in on and off', async () => {
    const userId = await insertUser();
    await userRepository.setInterruptionFeedback(userId, { agent_completed: true, agent_failed: false });
    await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [] }, NOW);
    await userRepository.setBusyBlocks(userId, { enabled: false, blocks: [] }, NOW);
    expect(await userRepository.getInterruptionFeedback(userId)).toEqual({
      agent_completed: true,
      agent_failed: false,
    });
  });
});

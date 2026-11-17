import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';
import { QuestMasterPlan } from '../content/QuestMasterPlanModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  await User.deleteMany({});
  await QuestMasterPlan.collection.deleteMany({});
});

describe('durable free quest admission', () => {
  const seed = () => User.create({ username: 'quester', name: 'Quester', currentCredits: 100 });

  it('admits exactly one of concurrent distinct starts without changing credits', async () => {
    const user = await seed();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => userRepository.claimFreeQuestStart(user.id, `start-${i}`))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await User.findById(user.id))!.currentCredits).toBe(100);
  });

  it('allows queue redelivery of the admitted start, but not a new start', async () => {
    const user = await seed();
    expect(await userRepository.claimFreeQuestStart(user.id, 'first')).toBe(true);
    expect(await userRepository.claimFreeQuestStart(user.id, 'first')).toBe(true);
    expect(await userRepository.claimFreeQuestStart(user.id, 'second')).toBe(false);
  });

  it('does not restore the allowance after soft or hard deletion of the plan', async () => {
    const user = await seed();
    expect(await userRepository.claimFreeQuestStart(user.id, 'first')).toBe(true);
    const plan = await QuestMasterPlan.create({ userId: user.id, notebookId: 'session', goal: 'Goal', quests: [] });
    await QuestMasterPlan.collection.updateOne({ _id: plan._id }, { $set: { deletedAt: new Date() } });
    expect(await userRepository.claimFreeQuestStart(user.id, 'second')).toBe(false);
    await QuestMasterPlan.collection.deleteOne({ _id: plan._id });
    expect(await userRepository.claimFreeQuestStart(user.id, 'third')).toBe(false);
  });

  it('does not admit a missing account', async () => {
    expect(await userRepository.claimFreeQuestStart(new mongoose.Types.ObjectId().toString(), 'first')).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

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

beforeEach(async () => {
  await Quest.collection.deleteMany({});
});

const seed = (userId: string, organizationId?: string, over: Record<string, unknown> = {}) =>
  Quest.create({
    sessionId: 'session-1',
    type: 'chat',
    timestamp: new Date(),
    promptMeta: { session: { id: 'session-1', userId, ...(organizationId ? { organizationId } : {}) } },
    ...over,
  });

describe('questRepository.findOrganizationIdsForUser', () => {
  // A DSAR must reach the organizations a now-deleted quest was recorded under; the soft-delete
  // plugin's default filter would hide exactly those.
  it('returns the organization ids of live and soft-deleted quests, dropping nulls', async () => {
    await seed('user-1', 'org-live');
    await seed('user-1', 'org-deleted', { deletedAt: new Date() });
    await seed('user-1');
    await seed('user-2', 'org-other');

    expect((await questRepository.findOrganizationIdsForUser('user-1')).sort()).toEqual(['org-deleted', 'org-live']);
  });
});

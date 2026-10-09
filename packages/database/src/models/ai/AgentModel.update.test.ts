import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Agent, agentRepository } from './AgentModel';

// The PATCH /api/v1/agents/{id} write path: `unset` clears model settings back to the default, and a
// soft-deleted agent is invisible to the lookups the v1 routes make.
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
  await Agent.deleteMany({}, { hardDelete: true });
});

const makeAgent = () =>
  Agent.create({
    name: 'Researcher',
    description: 'desc',
    userId: 'user-me',
    triggerWords: ['@help'],
    capabilities: ['{}'],
    preferredModel: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2048,
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
  });

describe('AgentRepository.update with unset', () => {
  it('removes the unset fields and writes the rest in one update', async () => {
    const agent = await makeAgent();

    const updated = await agentRepository.update(
      { id: agent.id, name: 'Renamed' },
      { new: true, unset: ['preferredModel', 'temperature', 'maxTokens'] }
    );

    expect(updated).toMatchObject({ name: 'Renamed' });
    const stored = await Agent.findById(agent.id).lean();
    expect(stored).toMatchObject({ name: 'Renamed' });
    expect(stored).not.toHaveProperty('preferredModel');
    expect(stored).not.toHaveProperty('temperature');
    expect(stored).not.toHaveProperty('maxTokens');
  });
});

describe('a soft-deleted agent', () => {
  it('is not found by id and not listed', async () => {
    const agent = await makeAgent();
    await agentRepository.delete(agent.id);

    expect(await agentRepository.findById(agent.id)).toBeNull();
    expect((await agentRepository.listAccessibleAfterId('user-me', { limit: 10 })).data).toEqual([]);
  });
});

describe('listAccessibleAfterId past the last id', () => {
  it('returns an empty final page', async () => {
    await makeAgent();
    const page = await agentRepository.listAccessibleAfterId('user-me', {
      afterId: 'ffffffffffffffffffffffff',
      limit: 10,
    });

    expect(page).toMatchObject({ data: [], hasMore: false });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Agent, agentRepository } from './AgentModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Agent.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Agent.deleteMany({}, { hardDelete: true });
});

const ME = 'user-me';
const OTHER = 'user-other';

const makeAgent = (name: string, overrides: Record<string, unknown> = {}) =>
  Agent.create({
    name,
    description: `${name} description`,
    userId: ME,
    triggerWords: ['@help'],
    capabilities: ['{}'],
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    ...overrides,
  });

async function collectAllPages(limit: number) {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await agentRepository.listAccessibleAfterId(ME, { afterId, limit });
    expect(page.data.length).toBeLessThanOrEqual(limit);
    ids.push(...page.data.map(agent => String(agent.id)));
    if (!page.hasMore) return ids;
    afterId = ids[ids.length - 1];
  }
  throw new Error('pagination did not terminate');
}

describe('AgentRepository.listAccessibleAfterId', () => {
  it('walks every accessible agent once, in ascending _id order, across keyset pages', async () => {
    const created = [];
    for (let index = 0; index < 5; index++) created.push(await makeAgent(`a${index}`));
    const expected = created.map(agent => String(agent.id)).sort();

    expect(await collectAllPages(2)).toEqual(expected);
  });

  it('reports hasMore only while another page exists', async () => {
    await makeAgent('a');
    await makeAgent('b');

    const exact = await agentRepository.listAccessibleAfterId(ME, { limit: 2 });
    expect(exact.data).toHaveLength(2);
    expect(exact.hasMore).toBe(false);

    const short = await agentRepository.listAccessibleAfterId(ME, { limit: 1 });
    expect(short.hasMore).toBe(true);
  });

  it('lists owned and shared agents, and no stranger, system, org or deleted agent', async () => {
    const mine = await makeAgent('mine');
    const shared = await makeAgent('shared', { userId: OTHER, users: [{ userId: ME, permissions: ['read'] }] });
    await makeAgent('foreign', { userId: OTHER });
    await makeAgent('system', { userId: undefined, isSystem: true });
    await makeAgent('org', { userId: undefined, organizationId: 'org-1' });
    const deleted = await makeAgent('deleted');
    await Agent.deleteOne({ _id: deleted._id });

    expect(await collectAllPages(1)).toEqual([String(mine.id), String(shared.id)].sort());
  });

  it('rejects a non-ObjectId cursor id instead of sending it to Mongo', async () => {
    await expect(agentRepository.listAccessibleAfterId(ME, { afterId: 'nope', limit: 1 })).rejects.toThrow(
      /Invalid agent cursor id/
    );
  });
});

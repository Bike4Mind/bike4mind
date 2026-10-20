import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const seed = (knowledgeIds: string[]) =>
  Session.create({
    userId: 'userA',
    name: 'chat',
    firstCreated: new Date('2023-01-01'),
    lastUpdated: new Date('2023-02-01'),
    knowledgeIds,
  });

const knowledgeIdsOf = async (id: string) => (await Session.findById(id).lean())?.knowledgeIds;

describe('SessionRepository.pullKnowledgeIds', () => {
  it('removes every given id from every session holding any of them, leaving other ids alone', async () => {
    const both = await seed(['f1', 'keep', 'f2']);
    const one = await seed(['f2']);
    const untouched = await seed(['keep']);

    const modified = await sessionRepository.pullKnowledgeIds(['f1', 'f2']);

    expect(modified).toBe(2);
    expect(await knowledgeIdsOf(both.id)).toEqual(['keep']);
    expect(await knowledgeIdsOf(one.id)).toEqual([]);
    expect(await knowledgeIdsOf(untouched.id)).toEqual(['keep']);
  });

  it('does not lose a removal when two pulls on the same session run concurrently', async () => {
    const session = await seed(['f1', 'keep', 'f2']);

    await Promise.all([sessionRepository.pullKnowledgeIds(['f1']), sessionRepository.pullKnowledgeIds(['f2'])]);

    expect(await knowledgeIdsOf(session.id)).toEqual(['keep']);
  });

  it('is a no-op for an empty id list', async () => {
    const session = await seed(['f1']);

    expect(await sessionRepository.pullKnowledgeIds([])).toBe(0);
    expect(await knowledgeIdsOf(session.id)).toEqual(['f1']);
  });
});

describe('SessionRepository.pullKnowledgeIdsFromSession', () => {
  it('removes the ids from the named session only', async () => {
    const target = await seed(['f1', 'keep']);
    const other = await seed(['f1']);

    expect(await sessionRepository.pullKnowledgeIdsFromSession(target.id, ['f1'])).toBe(true);
    expect(await knowledgeIdsOf(target.id)).toEqual(['keep']);
    expect(await knowledgeIdsOf(other.id)).toEqual(['f1']);
  });

  it('reports false when the session held none of the ids, and for an empty list or malformed id', async () => {
    const session = await seed(['keep']);

    expect(await sessionRepository.pullKnowledgeIdsFromSession(session.id, ['f1'])).toBe(false);
    expect(await sessionRepository.pullKnowledgeIdsFromSession(session.id, [])).toBe(false);
    expect(await sessionRepository.pullKnowledgeIdsFromSession('not-an-id', ['keep'])).toBe(false);
    expect(await knowledgeIdsOf(session.id)).toEqual(['keep']);
  });
});

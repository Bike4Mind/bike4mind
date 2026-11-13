import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Skill, skillRepository } from './SkillModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  await Skill.deleteMany({}, { hardDelete: true });
});

const make = (name: string, extra: Record<string, unknown>) =>
  Skill.create({ name, description: 'd', body: 'b', ...extra }).then(doc => String(doc._id));

describe('findAccessibleByIdsForUser', () => {
  it('returns owned, shared and global-read skills in input order, and skips the rest', async () => {
    const owned = await make('owned', { userId: 'u1' });
    const shared = await make('shared', { userId: 'u2', users: [{ userId: 'u1', permissions: ['read'] }] });
    const global = await make('global', { userId: 'u2', isGlobalRead: true });
    const foreign = await make('foreign', { userId: 'u2' });
    const deleted = await make('deleted', { userId: 'u1' });
    await skillRepository.delete(deleted);

    const found = await skillRepository.findAccessibleByIdsForUser('u1', [
      global,
      foreign,
      deleted,
      'not-an-id',
      shared,
      owned,
    ]);
    expect(found.map(skill => skill.name)).toEqual(['global', 'shared', 'owned']);
    expect(await skillRepository.findAccessibleByIdsForUser('u1', [])).toEqual([]);
  });
});

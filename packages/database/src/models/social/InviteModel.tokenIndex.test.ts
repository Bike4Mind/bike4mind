import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Invite } from './InviteModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Invite.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Invite.deleteMany({});
});

const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';
const invite = (over: Record<string, unknown> = {}) => ({ type: 'FabFile', documentId: 'doc-1', ...over });

/**
 * The token is a bearer secret resolved on its own, so uniqueness is the constraint that makes one
 * row the only possible answer - not a query hint. It is declared PARTIAL rather than sparse because
 * DocumentDB honours `unique` on a sparse index but not the sparseness, which would make the legacy
 * tokenless population collide on the missing value.
 */
describe('Invite invite_token_unique index', () => {
  it('is declared partial on a string token, not sparse', async () => {
    const declared = await Invite.collection.indexes();
    const index = declared.find(i => i.name === 'invite_token_unique');

    expect(index).toBeDefined();
    expect(index?.unique).toBe(true);
    expect(index?.partialFilterExpression).toEqual({ token: { $type: 'string' } });
    expect(index?.sparse).toBeUndefined();
  });

  it('refuses a second invite carrying the same token', async () => {
    await Invite.create(invite({ token: TOKEN }));
    await expect(Invite.create(invite({ token: TOKEN }))).rejects.toThrow(/E11000/);
  });

  it('admits many legacy invites with no token at all', async () => {
    await Invite.create(invite());
    await Invite.create(invite());
    expect(await Invite.countDocuments({})).toBe(2);
  });

  // The difference `$type: 'string'` buys over `$exists`: an explicit null is a present field, so a
  // sparse index would have indexed it and the second row would collide.
  it('admits many invites whose token is explicitly null', async () => {
    await Invite.collection.insertMany([invite({ token: null }), invite({ token: null })]);
    expect(await Invite.countDocuments({ token: null })).toBe(2);
  });

  it('still separates two different tokens', async () => {
    await Invite.create(invite({ token: TOKEN }));
    await Invite.create(invite({ token: `${TOKEN.slice(0, -1)}X` }));
    expect(await Invite.countDocuments({})).toBe(2);
  });
});

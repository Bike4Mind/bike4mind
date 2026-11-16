import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { Invite } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261116081402_revoke-project-invites-without-inviter';

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
  await Invite.deleteMany({});
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// Raw inserts: the rows this migration targets predate fields the schema now defaults.
const seed = async (fields: Record<string, unknown>) => {
  const { insertedId } = await Invite.collection.insertOne({
    type: 'Project',
    documentId: 'project-1',
    remaining: 1,
    available: 1,
    recipients: { pending: ['pending@example.com'], accepted: ['accepted@example.com'], refused: [] },
    ...fields,
  });
  return insertedId;
};

const stored = async (id: unknown) => {
  const row = await Invite.collection.findOne({ _id: id as mongoose.Types.ObjectId });
  return { remaining: row?.remaining, revokedAt: row?.revokedAt ?? null, recipients: row?.recipients };
};

describe('revoke-project-invites-without-inviter migration (real DB)', () => {
  it('closes Project invites with a missing, null or empty inviterId and keeps who accepted', async () => {
    const ids = [await seed({}), await seed({ inviterId: null }), await seed({ inviterId: '' })];

    await migration.up();

    for (const id of ids) {
      const row = await stored(id);
      expect(row.remaining).toBe(0);
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.recipients).toEqual({ pending: [], accepted: ['accepted@example.com'], refused: [] });
    }
  });

  it('closes a row that has no recipients object without inventing one', async () => {
    const id = await seed({ recipients: undefined });

    await migration.up();

    const row = await stored(id);
    expect(row.remaining).toBe(0);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.recipients ?? null).toBeNull();
  });

  it('leaves every other invite as it was', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const untouched = {
      withInviter: await seed({ inviterId: 'user-1' }),
      alreadyRevoked: await seed({ revokedAt: earlier, remaining: 1 }),
      spent: await seed({ remaining: 0 }),
      fabFile: await seed({ type: 'FabFile' }),
      session: await seed({ type: 'Session' }),
      organization: await seed({ type: 'Organization' }),
    };
    const before = Object.fromEntries(
      await Promise.all(Object.entries(untouched).map(async ([name, id]) => [name, await stored(id)]))
    );

    await migration.up();

    for (const [name, id] of Object.entries(untouched)) expect(await stored(id)).toEqual(before[name]);
  });

  it('changes nothing on a second run', async () => {
    const id = await seed({});
    await migration.up();
    const first = await stored(id);

    await migration.up();

    expect(await stored(id)).toEqual(first);
  });
});

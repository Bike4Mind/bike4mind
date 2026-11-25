import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Migration, QuestGraph, QuestMasterPlan, QuestNode } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, {
  LEGACY_QUEST_PLAN_COLLECTIONS,
  LEGACY_QUEST_PLAN_FIELDS,
  VERIFY_LEGACY_QUEST_PLAN_FILES_ID,
} from './20261125121820_drop-legacy-quest-plan-collections';
import { AvailableMigrations } from './index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const V5_FLAG = 'preferences.experimentalFeatures.enableQuestMasterV5';

let server: Awaited<ReturnType<typeof createMongoServer>>;
const db = () => mongoose.connection.db!;
const collectionNames = async () => (await db().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await db().dropDatabase();
});

const markVerified = (migratedAt = new Date(Date.now() - 60_000)) =>
  Migration.create({
    id: VERIFY_LEGACY_QUEST_PLAN_FILES_ID,
    name: 'verify legacy quest plan file coverage',
    migratedAt,
  });

const seed = async () => {
  await db()
    .collection('questmasterplans')
    .insertMany([{ goal: 'a' }, { goal: 'b', deletedAt: new Date() }]);
  await db().collection('questgraphs').insertOne({ goal: 'g' });
  await db()
    .collection('questnodes')
    .insertMany([{ graphId: 'g1' }, { graphId: 'g1' }]);
  await db()
    .collection('quests')
    .insertMany([
      ...Array.from({ length: 1005 }, (_, i) => ({ sessionId: 's', prompt: `p${i}`, questMasterPlanId: `plan${i}` })),
      { sessionId: 's', prompt: 'no plan' },
    ]);
  await db()
    .collection('users')
    .insertMany([
      {
        email: 'v5@x.test',
        username: 'v5',
        preferences: { experimentalFeatures: { enableQuestMasterV5: true, enableQuestMaster: true } },
      },
      { email: 'off@x.test', username: 'off', preferences: { experimentalFeatures: { enableQuestMasterV5: false } } },
      { email: 'none@x.test', username: 'none', preferences: { experimentalFeatures: { enableMementos: true } } },
    ]);
};

describe('drop legacy quest plan collections migration', () => {
  it('is registered after the coverage check', () => {
    expect(AvailableMigrations).toContain(migration);
    const verify = AvailableMigrations.find(m => m.id === VERIFY_LEGACY_QUEST_PLAN_FILES_ID);
    expect(verify?.name).toBe('verify legacy quest plan file coverage');
    expect(migration.id).toBe(20261125121820);
    expect(migration.id).toBeGreaterThan(VERIFY_LEGACY_QUEST_PLAN_FILES_ID);
  });

  it('stays pending and touches nothing until the coverage check has been applied', async () => {
    await seed();
    await expect(migration.up({ startedAt: new Date() })).resolves.toMatchObject({ incomplete: true });
    expect(await collectionNames()).toEqual(expect.arrayContaining([...LEGACY_QUEST_PLAN_COLLECTIONS]));
    expect(
      await db()
        .collection('quests')
        .countDocuments({ questMasterPlanId: { $exists: true } })
    ).toBe(1005);
  });

  it('stays pending and touches nothing when the coverage check was applied in the same run', async () => {
    await seed();
    const startedAt = new Date(Date.now() - 60_000);
    await markVerified(new Date());
    await expect(migration.up({ startedAt })).resolves.toMatchObject({ incomplete: true });
    expect(await collectionNames()).toEqual(expect.arrayContaining([...LEGACY_QUEST_PLAN_COLLECTIONS]));
    expect(
      await db()
        .collection('quests')
        .countDocuments({ questMasterPlanId: { $exists: true } })
    ).toBe(1005);
  });

  it('keeps the legacy models from recreating the dropped collections', () => {
    for (const model of [QuestMasterPlan, QuestGraph, QuestNode]) {
      expect(model.schema.get('autoCreate')).toBe(false);
      expect(model.schema.get('autoIndex')).toBe(false);
    }
  });

  it('unsets only the retired v5 flag, never the chat-history plan marker', () => {
    expect(LEGACY_QUEST_PLAN_FIELDS).toEqual([
      { collection: 'users', field: 'preferences.experimentalFeatures.enableQuestMasterV5' },
    ]);
  });

  it('drops the legacy collections, unsets the v5 flag, logs counts and leaves chat history untouched', async () => {
    await seed();
    await markVerified();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(migration.up({ startedAt: new Date() })).resolves.toBeUndefined();

    const names = await collectionNames();
    for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) expect(names).not.toContain(name);

    const quests = db().collection('quests');
    expect(await quests.countDocuments({})).toBe(1006);
    // The legacy-plan note and notebook curation key off this field, so every one of them survives.
    expect(await quests.countDocuments({ questMasterPlanId: { $exists: true } })).toBe(1005);
    expect(await quests.findOne({ prompt: 'p7' })).toMatchObject({ sessionId: 's', questMasterPlanId: 'plan7' });
    expect(await quests.findOne({ prompt: 'no plan' })).not.toHaveProperty('questMasterPlanId');

    const users = db().collection('users');
    expect(await users.countDocuments({ [V5_FLAG]: { $exists: true } })).toBe(0);
    expect(await users.findOne({ email: 'v5@x.test' })).toMatchObject({
      preferences: { experimentalFeatures: { enableQuestMaster: true } },
    });
    expect(await users.findOne({ email: 'none@x.test' })).toMatchObject({
      preferences: { experimentalFeatures: { enableMementos: true } },
    });

    const logs = info.mock.calls.map(call => String(call[0]));
    expect(logs).toContainEqual(
      expect.stringContaining(
        `Legacy quest plan data before: questmasterplans=2 questgraphs=1 questnodes=2 users.${V5_FLAG}=2`
      )
    );
    expect(logs).toContainEqual(
      expect.stringContaining(
        `Legacy quest plan data after: questmasterplans=0 questgraphs=0 questnodes=0 users.${V5_FLAG}=0`
      )
    );
    info.mockRestore();
  });

  it('leaves the readers that still name the legacy models as no-ops that do not recreate a collection', async () => {
    await seed();
    await markVerified();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(migration.up({ startedAt: new Date() })).resolves.toBeUndefined();

    // The same operations the gear check, the account archive, the data-subject export and the
    // erasure/purge registries run against these models while the model files still exist.
    const owner = { userId: 'owner-1' };
    expect(await QuestMasterPlan.exists(owner)).toBeNull();
    expect(await QuestMasterPlan.findById(new mongoose.Types.ObjectId())).toBeNull();
    for (const model of [QuestMasterPlan, QuestGraph, QuestNode]) {
      const collection = db().collection(model.collection.name);
      expect(await collection.find(owner, { projection: { _id: 1 } }).toArray()).toEqual([]);
      expect(await collection.estimatedDocumentCount()).toBe(0);
      expect(await collection.deleteMany(owner)).toMatchObject({ deletedCount: 0 });
      // update-validators-off: native driver on the raw collection has no schema
      expect(await collection.updateMany(owner, { $pull: { sharedWith: 'owner-1' } })).toMatchObject({
        matchedCount: 0,
        upsertedCount: 0,
      });
    }

    const names = await collectionNames();
    for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) expect(names).not.toContain(name);
    vi.restoreAllMocks();
  });

  it('is a no-op when the collections are already gone and re-runs cleanly', async () => {
    await markVerified();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(migration.up({ startedAt: new Date() })).resolves.toBeUndefined();

    await seed();
    await expect(migration.up({ startedAt: new Date() })).resolves.toBeUndefined();
    await expect(migration.up({ startedAt: new Date() })).resolves.toBeUndefined();
    for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) expect(await collectionNames()).not.toContain(name);
    vi.restoreAllMocks();
  });
});

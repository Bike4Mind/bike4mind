import { Migration, mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Must stay in sync with VerifyLegacyQuestPlanFiles (20260921249990_verify-legacy-quest-plan-files.ts).
// Referenced by id rather than imported: that module pulls in the whole conversion service stack.
export const VERIFY_LEGACY_QUEST_PLAN_FILES_ID = 20260921249990;

// v4 plans, v5 graphs and v5 nodes. Named directly because their models are deleted after this runs.
export const LEGACY_QUEST_PLAN_COLLECTIONS = ['questmasterplans', 'questgraphs', 'questnodes'] as const;

// Retired references: the v4 plan id on chat history and the v5 opt-in flag on user preferences.
export const LEGACY_QUEST_PLAN_FIELDS = [
  { collection: 'quests', field: 'questMasterPlanId' },
  { collection: 'users', field: 'preferences.experimentalFeatures.enableQuestMasterV5' },
] as const;

type DocId = mongoose.Types.ObjectId | string;

const BATCH_SIZE = 1000;
// Under the migrator Lambda's 15-minute timeout; counted from the start of the run, like the conversion.
const RUN_MS = 12 * 60 * 1000;

const db = () => {
  const database = mongoose.connection.db;
  if (!database) throw new Error('drop legacy quest plan collections: no database connection');
  return database;
};

const collectionExists = async (name: string) =>
  (await db().listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

const counts = async () => {
  const result: Record<string, number> = {};
  for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) {
    result[name] = (await collectionExists(name)) ? await db().collection(name).countDocuments() : 0;
  }
  for (const { collection, field } of LEGACY_QUEST_PLAN_FIELDS) {
    result[`${collection}.${field}`] = await db()
      .collection(collection)
      .countDocuments({ [field]: { $exists: true } });
  }
  return result;
};

const format = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([key, n]) => `${key}=${n}`)
    .join(' ');

/** Unsets `field` in batches over one cursor pass, so a large unindexed collection is scanned once. */
const unsetField = async (collection: string, field: string, deadline: Date): Promise<boolean> => {
  const coll = db().collection<{ _id: DocId }>(collection);
  const flush = async (ids: DocId[]) => {
    if (ids.length) await coll.updateMany({ _id: { $in: ids } }, { $unset: { [field]: '' } });
  };
  const cursor = coll.find({ [field]: { $exists: true } }, { projection: { _id: 1 } }).batchSize(BATCH_SIZE);
  let ids: DocId[] = [];
  try {
    for await (const doc of cursor) {
      ids.push(doc._id);
      if (ids.length < BATCH_SIZE) continue;
      await flush(ids);
      ids = [];
      if (Date.now() > deadline.getTime()) return false;
    }
    await flush(ids);
    return true;
  } finally {
    await cursor.close();
  }
};

/**
 * Removes the retired Questmaster v4/v5 data once its markdown files are verified: unsets the
 * references first, then drops the legacy collections. Logs per-collection counts before and after.
 *
 * Runs only after VerifyLegacyQuestPlanFiles was applied in an earlier migrator run, so the drop
 * always ships in a later deploy than the coverage check. Idempotent and resumable: every step
 * filters on what is still present and a missing collection is skipped. The Quest model is chat
 * history; the only change to it is the `$unset`. Irreversible, so down is a no-op.
 */
const migration: MigrationFile = {
  // Backdated below EnsureOAuthGrantClientUserIndex (20260922000000) so it sorts after the coverage
  // check but before the OAuth backfill, which must sort last.
  id: 20260921253850,
  name: 'drop legacy quest plan collections',

  up: async ctx => {
    const startedAt = ctx?.startedAt ?? new Date();
    const verified = await Migration.exists({
      id: VERIFY_LEGACY_QUEST_PLAN_FILES_ID,
      migratedAt: { $lt: startedAt },
    });
    if (!verified) {
      return { incomplete: true, reason: 'waiting for the legacy quest plan file check to pass in an earlier run' };
    }

    console.info(`Legacy quest plan data before: ${format(await counts())}`);

    const deadline = new Date(startedAt.getTime() + RUN_MS);
    for (const { collection, field } of LEGACY_QUEST_PLAN_FIELDS) {
      if (!(await unsetField(collection, field, deadline))) {
        return { incomplete: true, reason: `ran out of time unsetting ${collection}.${field}` };
      }
    }
    for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) {
      if (await collectionExists(name)) await db().dropCollection(name);
    }

    console.info(`Legacy quest plan data after: ${format(await counts())}`);
  },

  down: async () => {},
};

export default migration;

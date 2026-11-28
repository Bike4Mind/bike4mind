import { Migration, mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Must stay in sync with VerifyLegacyQuestPlanFiles (20260921249990_verify-legacy-quest-plan-files.ts).
// Referenced by id rather than imported: that module pulls in the whole conversion service stack.
export const VERIFY_LEGACY_QUEST_PLAN_FILES_ID = 20260921249990;

// v4 plans, v5 graphs and v5 nodes. Named directly because their models are deleted after this runs.
export const LEGACY_QUEST_PLAN_COLLECTIONS = ['questmasterplans', 'questgraphs', 'questnodes'] as const;

// Retired references: the v5 opt-in flag on user preferences.
//
// `quests.questMasterPlanId` is deliberately NOT here. It no longer resolves to a plan row, but it is
// still a live marker: the chat shows the "plan moved to your files" note for a message that carries
// it (isLegacyQuestMasterMessage in apps/client), and notebook curation and notebook export read it.
// Unsetting it would silently remove that note from old plan replies.
export const LEGACY_QUEST_PLAN_FIELDS = [
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

const existingLegacyCollections = async () =>
  new Set(
    (
      await db()
        .listCollections({ name: { $in: [...LEGACY_QUEST_PLAN_COLLECTIONS] } }, { nameOnly: true })
        .toArray()
    ).map(c => c.name)
  );

const counts = async () => {
  const result: Record<string, number> = {};
  const existing = await existingLegacyCollections();
  for (const name of LEGACY_QUEST_PLAN_COLLECTIONS) {
    result[name] = existing.has(name) ? await db().collection(name).countDocuments() : 0;
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
    if (!ids.length) return;
    // update-validators-off: native driver on the raw collection has no schema, and this only unsets a field
    await coll.updateMany({ _id: { $in: ids } }, { $unset: { [field]: '' } });
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
 * filters on what is still present and a missing collection is skipped. Chat history (the Quest
 * model) is not touched: `questMasterPlanId` stays as the marker for the legacy-plan note.
 * Irreversible, so down is a no-op.
 */
const migration: MigrationFile = {
  // A generated UTC timestamp (scripts/check-migration-ids.mjs). It sorts after the coverage check,
  // but the order that matters is enforced in up(): the check must be applied in an earlier run.
  id: 20261125121820,
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
    for (const name of await existingLegacyCollections()) await db().dropCollection(name);

    console.info(`Legacy quest plan data after: ${format(await counts())}`);
  },

  down: async () => {},
};

export default migration;

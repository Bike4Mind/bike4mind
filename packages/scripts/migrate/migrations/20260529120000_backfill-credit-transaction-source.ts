import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: backfill `source` on existing CreditTransaction rows.
 *
 * `source` was added so daily/weekly reports can break down usage by surface
 * (web / cli / api / agent / system). Historical rows pre-date the field. We
 * assign a type-aware default rather than blanket-defaulting everything to
 * 'web', because completion_api_usage transactions came from the public
 * completions endpoint (CLI / 3rd-party API) - labelling those as 'web' would
 * be actively wrong and would distort the report breakdown.
 *
 * Rules:
 *   text_generation_usage / image_generation_usage / image_edit_usage /
 *   video_generation_usage / realtime_voice_usage / tool_usage /
 *   speech_to_text_usage                                       -> 'web'
 *   completion_api_usage  with  apiKeyId set                   -> 'api'
 *   completion_api_usage  without apiKeyId  (JWT-auth CLI)     -> 'cli'
 *   purchase / subscription / generic_add / generic_deduct /
 *   transfer_credit / received_credit                          -> left untouched
 *     (source isn't meaningful for non-usage transactions)
 *
 * Idempotent: each step matches only rows where `source` is unset.
 *
 * Writes are batched by `_id` cursor (BATCH_SIZE) to avoid taking a long lock
 * on `credittransactions` (high-volume financial ledger) during a single
 * unbatched updateMany.
 */

const WEB_USAGE_TYPES = [
  'text_generation_usage',
  'image_generation_usage',
  'image_edit_usage',
  'video_generation_usage',
  'realtime_voice_usage',
  'tool_usage',
  'speech_to_text_usage',
] as const;

const BATCH_SIZE = 1000;

type Filter = Record<string, unknown>;

/**
 * Apply `$set: { source }` in `_id`-paginated batches to a collection.
 * Each batch fetches up to BATCH_SIZE matching `_id`s and updateMany's only
 * those. Yields between batches so a long-running migration doesn't hold a
 * single lock for the duration of the scan.
 */
async function backfillInBatches(
  collection: ReturnType<NonNullable<typeof mongoose.connection.db>['collection']>,
  filter: Filter,
  source: 'web' | 'cli' | 'api'
): Promise<number> {
  let totalModified = 0;
  // Loop until a batch returns nothing - guarantees termination as long as the
  // update removes rows from the filter (source: { $exists: false }).

  while (true) {
    const batch = await collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();

    if (batch.length === 0) break;

    const ids = batch.map(doc => doc._id);
    const result = await collection.updateMany({ _id: { $in: ids } }, { $set: { source } });
    totalModified += result.modifiedCount;

    if (batch.length < BATCH_SIZE) break;
  }
  return totalModified;
}

const migration: MigrationFile = {
  id: 20260529120000,
  name: 'backfill-credit-transaction-source',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const creditTransactions = db.collection('credittransactions');

    // 1. Web-originated usage types (chat/image/video/voice/tool/STT)
    const webModified = await backfillInBatches(
      creditTransactions,
      { type: { $in: WEB_USAGE_TYPES as unknown as string[] }, source: { $exists: false } },
      'web'
    );
    console.log(`✅ Tagged ${webModified} web-usage transactions as source='web'`);

    // 2. completion_api_usage rows with apiKeyId -> 'api' (third-party API key callers)
    const apiModified = await backfillInBatches(
      creditTransactions,
      {
        type: 'completion_api_usage',
        apiKeyId: { $exists: true, $ne: null },
        source: { $exists: false },
      },
      'api'
    );
    console.log(`✅ Tagged ${apiModified} API-key completion_api_usage rows as source='api'`);

    // 3. completion_api_usage rows without apiKeyId -> 'cli'
    //    Historically, the only published consumer of /api/ai/v1/completions
    //    on JWT auth was the B4M CLI. Tagging these 'cli' is the best
    //    available default; any non-CLI JWT caller (rare) will be mislabelled.
    const cliModified = await backfillInBatches(
      creditTransactions,
      {
        type: 'completion_api_usage',
        $or: [{ apiKeyId: { $exists: false } }, { apiKeyId: null }],
        source: { $exists: false },
      },
      'cli'
    );
    console.log(`✅ Tagged ${cliModified} JWT completion_api_usage rows as source='cli'`);

    // 4. Non-usage types intentionally left untouched. Log the count so the
    //    operator can see what was skipped.
    const untouched = await creditTransactions.countDocuments({
      type: { $nin: [...WEB_USAGE_TYPES, 'completion_api_usage'] },
      source: { $exists: false },
    });
    console.log(`ℹ️  ${untouched} non-usage transactions left without source (purchases, refunds, transfers, …)`);
  },

  down: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const creditTransactions = db.collection('credittransactions');

    // LOSSY ROLLBACK
    // Application code now writes `source: 'web' | 'cli' | 'api'` on NEW
    // transactions. The migration leaves no marker distinguishing backfilled
    // rows from app-written ones, so this `$unset` will clobber the source
    // field on rows the app set after this migration ran. Only run down() if
    // you accept losing that attribution on post-migration usage rows.
    //
    // Run in batches so the rollback itself doesn't lock the collection.
    let totalModified = 0;

    while (true) {
      const batch = await creditTransactions
        .find({ source: { $in: ['web', 'cli', 'api'] } }, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();

      if (batch.length === 0) break;

      const ids = batch.map(doc => doc._id);
      const result = await creditTransactions.updateMany({ _id: { $in: ids } }, { $unset: { source: '' } });
      totalModified += result.modifiedCount;

      if (batch.length < BATCH_SIZE) break;
    }
    console.log(`Removed source field from ${totalModified} CreditTransaction rows (lossy — see migration comment)`);
  },
};

export default migration;

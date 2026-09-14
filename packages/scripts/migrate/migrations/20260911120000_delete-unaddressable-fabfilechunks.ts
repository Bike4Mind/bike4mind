import { FabFileChunk } from '@bike4mind/database';
import { type MigrationFile } from './index';
import { scanUnaddressableChunks } from '../unaddressableChunkScan';

/**
 * Delete `fabfilechunks` rows whose `fabFileId` is not an ObjectId string.
 *
 * `fabFileId` is a plain String with a `ref`, so a value that cannot address a FabFile by `_id`
 * stores clean. A batch of rows holding a whole serialized FabFile document got in that way around
 * 2024-10-03; the code responsible is long gone. Every RETRIEVAL AND REAP path reaches a chunk
 * through `fabFileId` (`findVectorsByFabFileIds`, `findByFabFileId`, `$vectorSearch`'s `$in`
 * filter), so such a row is invisible to retrieval, and `deleteManyByFabFileId` matches the same
 * field, so ordinary file deletion never reaped it either. It is unreachable dead weight in both
 * directions.
 *
 * Note the narrowing: collection-wide maintenance scanners DO reach these rows without going
 * through `fabFileId` (`findChunksMissingEmbeddingModel`, `findChunkIdsMissingCharLength`,
 * `backfillCharLengthByIds`, and `vectorize`'s `findById` from a queue message). None of them is a
 * user-facing path, so the unreachability argument survives - but one of them is how these rows
 * crashed the embedding-model backfill, which is what surfaced them in the first place.
 *
 * A registered migration rather than a hand-run script because a hand-run script does not get run.
 * The schema now carries a format validator on the field (FabFileChunkSchema, packages/database),
 * so this is a one-time sweep - though not an exhaustive one: the server-side gate uses PCRE `$`
 * semantics and so leaves a `<24hex>\n` value in place. See unaddressableChunkScan.ts.
 *
 * SHAPE, not a hardcoded id list - the affected set differs per environment. Two gates, and a row
 * has to fail both to be deleted:
 *
 *  1. `fabFileId` is a string that is not 24 hex characters, so it cannot address a row by `_id`.
 *     Deliberately scoped to strings: a row with the field absent or of another type is a different
 *     corruption with a different safety argument, and is left for whoever finds it.
 *  2. No ObjectId recoverable FROM that string resolves to a fabfile. The serialized documents
 *     embed the original file's id, so every 24-hex window in the value is looked up; if any hits a
 *     fabfile row - live OR soft-deleted - the chunk is KEPT and reported, because then someone
 *     could still re-associate it and a delete here would not be recoverable.
 *
 * To see the counts before acting, run the READ-ONLY preview against the target stage. It needs the
 * stage's linked MONGODB_URI, so it has to run inside `sst shell` - the bare pnpm invocation has no
 * database to reach:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts db:preview-unaddressable-chunks
 * There is deliberately no dry-run flag on this migration. The runner writes the ledger row as soon
 * as `up()` resolves (migrationManager.ts) and `selectPending` then skips the id forever, so a
 * dry-run that returned normally would permanently foreclose the real pass while reporting success.
 * Making it throw instead is no better: the migrator Lambda gates the web deploy (infra/web.ts), so
 * a dry-run at deploy time would fail the deploy and skip every migration queued behind it.
 *
 * NOT REVERSIBLE. `down()` is a no-op - the rows are gone and nothing reconstructs them. That is
 * the whole reason gate 2 errs towards keeping a row.
 */

const KEPT_ID_LOG_CAP = 50;

/** Pages between progress lines. A timeout inside a multi-minute scan is otherwise undiagnosable. */
const PROGRESS_EVERY_PAGES = 25;

const migration: MigrationFile = {
  id: 20260911120000,
  name: 'delete-unaddressable-fabfilechunks',

  up: async () => {
    const chunks = FabFileChunk.collection;
    let deleted = 0;
    let scanned = 0;
    let pages = 0;
    const keptIds: string[] = [];

    for await (const page of scanUnaddressableChunks()) {
      scanned += page.scanned;
      pages += 1;
      keptIds.push(...page.keptIds);

      if (page.deletable.length > 0) {
        deleted += (await chunks.deleteMany({ _id: { $in: page.deletable } })).deletedCount;
      }

      if (pages % PROGRESS_EVERY_PAGES === 0) {
        console.log(`  ... scanned ${scanned} unaddressable row(s), deleted ${deleted}, through _id ${page.lastId}`);
      }
    }

    console.log(`Deleted ${deleted} unaddressable fabfilechunk row(s) from ${scanned} scanned`);
    if (keptIds.length > 0) {
      // These need a human: the value is unaddressable but its embedded id still names a real file,
      // so the chunk may be worth re-pointing rather than dropping.
      console.warn(
        `${keptIds.length} row(s) have an unaddressable fabFileId that still embeds a resolvable file id - kept for manual review`
      );
      console.warn(`   chunk ids: ${keptIds.slice(0, KEPT_ID_LOG_CAP).join(', ')}`);
      if (keptIds.length > KEPT_ID_LOG_CAP) {
        console.warn(`   ... and ${keptIds.length - KEPT_ID_LOG_CAP} more (capped at ${KEPT_ID_LOG_CAP})`);
      }
    }
  },

  down: async () => {
    // Deleted rows are not reconstructable. See the docblock.
  },
};

export default migration;

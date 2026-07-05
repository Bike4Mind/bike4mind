import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: Lowercase existing agents' trigger words
 *
 * An earlier change normalized trigger words to lowercase on the WRITE path only (Zod
 * transform + AgentSchema pre('validate') hook). Existing agents stored with
 * uppercase trigger words (e.g. `@Coffee`) were deliberately not backfilled.
 * The case-sensitive `findByTriggerWords` ($in) query misses them on the
 * server-resolution fallback path (programmatic/scheduled sends, brand-new
 * sessions before the client attaches an agent), causing silent @mention
 * routing failures. This migration backfills those documents.
 *
 * Approach - batched read-modify-write (NOT an aggregation-pipeline update):
 * - DocumentDB-safe: pipeline-form updates (`updateMany(filter, [ {$set} ])`)
 *   are not supported on DocumentDB; lowercasing in JS works on both engines.
 * - Dedupe-safe: lowercasing can collapse collisions (e.g. ['@Bob','@bob']),
 *   which a raw `$map` would leave duplicated. We dedupe after lowercasing,
 *   matching the write-path `triggerWordsSchema` invariant.
 *
 * Idempotent / re-runnable: the filter only matches documents that still
 * contain an uppercase ASCII letter, and each batch lowercases those docs so
 * they no longer match - the query is self-consuming and a second run is a
 * no-op.
 */

const BATCH_SIZE = 200;

// Matches any trigger-word array element still containing an uppercase ASCII letter.
const UPPERCASE_TRIGGER_WORD_FILTER = {
  triggerWords: { $elemMatch: { $regex: /[A-Z]/ } },
};

const migration: MigrationFile = {
  id: 20260626000000,
  name: 'lowercase existing agent trigger words',

  up: async () => {
    console.log('Starting migration: lowercasing existing agent trigger words...');

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const agents = db.collection('agents');

    const total = await agents.countDocuments(UPPERCASE_TRIGGER_WORD_FILTER);
    console.log(`Found ${total} agents with uppercase trigger words`);
    if (total === 0) {
      console.log('No agents to update');
      return;
    }

    let processed = 0;
    let modified = 0;

    // Self-consuming loop: lowercased docs drop out of the filter, so each
    // pass fetches the next unmigrated batch - no skip/offset needed.
    while (true) {
      const docs = await agents
        .find(UPPERCASE_TRIGGER_WORD_FILTER, { projection: { triggerWords: 1 } })
        .limit(BATCH_SIZE)
        .toArray();

      if (docs.length === 0) break;

      const bulkOps = docs.map(doc => {
        const seen = new Set<string>();
        const lowered: string[] = [];
        for (const tw of (doc.triggerWords as string[]) ?? []) {
          if (typeof tw !== 'string') continue;
          const lower = tw.toLowerCase();
          if (seen.has(lower)) continue; // dedupe collisions introduced by lowercasing
          seen.add(lower);
          lowered.push(lower);
        }
        return {
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { triggerWords: lowered } },
          },
        };
      });

      const result = await agents.bulkWrite(bulkOps, { ordered: false });
      processed += docs.length;
      modified += result.modifiedCount ?? 0;
      console.log(`Processed ${processed}/${total} (modified ${modified})`);

      // Safety net: the filter is self-consuming (lowercased docs stop matching),
      // so a batch that found docs but modified none means those docs did not
      // drop out of the filter - break instead of rescanning the same set forever.
      if ((result.modifiedCount ?? 0) === 0) {
        console.warn(`Stopping early: ${docs.length} docs matched but none were modified; possible unexpected data.`);
        break;
      }
    }

    console.log(`✅ Migration completed. Lowercased trigger words on ${modified} agents.`);
  },

  down: async () => {
    // No rollback - original casing is unrecoverable, and lowercase is the
    // new write-path invariant, so reverting would reintroduce the bug.
    console.log('Rollback: no-op; original trigger-word casing cannot be restored.');
  },
};

export default migration;

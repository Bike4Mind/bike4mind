import { Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

export const OPEN_VOICE_HOLD_INDEX_NAME = 'voiceSessionStartedAt_1_openVoiceHold';
const SWEEP_INDEX_KEY = { voiceSessionStartedAt: 1 };

/**
 * Build the partial `voiceSessionStartedAt_1_openVoiceHold` index the stale voice hold sweep
 * (sessionRepository.findStaleVoiceHolds, run by the voiceHoldSweep cron every 5 minutes) reads,
 * and drop the `{ voiceSessionStartedAt: 1 }` index it replaces. The old one was partial on
 * `{ voiceSessionStartedAt: { $type: 'date' } }`, which the sweep's `$lt` ranges do not imply, so
 * the planner never chose it and the sweep walked every live session instead.
 *
 * Migration rather than autoIndex, as 20260921235980_ensure-session-origin-channel-index: autoIndex
 * builds are fire-and-forget (a failure is silent). The old index is found by key
 * pattern, not by its auto-derived name, which may differ; neither autoIndex nor
 * createIndexes drops an index the schema stopped declaring.
 *
 * Idempotent: a missing old index is skipped and createIndexes is a no-op for existing indexes.
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235986,
  name: 'ensure stale voice hold index',

  up: async () => {
    const db = Session.db.db;
    if (!db) throw new Error('No active MongoDB connection - cannot check sessions collection state');

    const collectionExists =
      (await db.listCollections({ name: Session.collection.collectionName }).toArray()).length === 1;
    if (collectionExists) {
      const superseded = (await Session.collection.indexes()).filter(
        index =>
          JSON.stringify(index.key) === JSON.stringify(SWEEP_INDEX_KEY) && index.name !== OPEN_VOICE_HOLD_INDEX_NAME
      );
      for (const index of superseded) {
        if (index.name) await Session.collection.dropIndex(index.name);
      }
    }
    await Session.createIndexes();
  },

  down: async () => {
    // The sweep depends on this index; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;

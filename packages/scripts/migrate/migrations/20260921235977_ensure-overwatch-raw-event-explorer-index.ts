import { OverwatchRawEvent } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ productId, event, timestamp }` index exists on overwatchrawevents.
 *
 * The Overwatch overlay reads this collection by one product, one named event (or an `$in` of a
 * few) and a `timestamp` range: the event explorer's counts, breakdowns and funnels, the funnel's
 * signup stage, attribution, roads and the event trend. With only `{ productId, timestamp }` the
 * planner walks every event the product sent in the window and filters `event` after fetching each
 * document, so the cost of one event's chart is the cost of the product's whole window.
 *
 * A migration as well as the schema declaration, as 20260921235993_ensure-artifact-owned-keyset-index:
 * web `dependsOn` the migration, so the index is committed before web serves the deploy. autoIndex is
 * on and the other Lambdas deploy alongside the migrator, so a cold boot may start this build first;
 * createIndex then waits for that build. A build past the connection's 45s socket timeout fails this
 * run, but the server finishes the build and the next deploy's run finds it. The collection is capped
 * by its 90-day TTL, and this is one more key per insert on the analytics ingest path.
 *
 * Builds only this index, not OverwatchRawEvent.createIndexes(), so a stage missing another
 * declared index does not build it here too. Idempotent: createIndex is a no-op when an identical
 * index already exists.
 *
 * Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001) to keep that
 * migration's id the highest on disk - its own test asserts that invariant.
 */
const migration: MigrationFile = {
  id: 20260921235977,
  name: 'ensure overwatch raw event explorer index',

  up: async () => {
    await OverwatchRawEvent.collection.createIndex({ productId: 1, event: 1, timestamp: -1 });
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put every named-event read back on a scan
    // of the product's window. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;

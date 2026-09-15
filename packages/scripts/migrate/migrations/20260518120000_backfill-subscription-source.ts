import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: prepare Subscription collection for admin-granted free orgs
 * and a clean Stripe conversion path.
 *
 * Four idempotent steps:
 *  1. Drop any sparse unique index on `subscriptionId`. DocumentDB does not
 *     honour sparse on unique indexes - it treats missing values as null and
 *     collides them. The new schema declares a plain (non-sparse) unique
 *     index; this step removes any earlier sparse variant left behind by an
 *     interim deploy. The legacy non-sparse unique index already matches the
 *     new schema, so it is preserved.
 *  2. Detect legacy admin grants - the earlier admin-grant endpoint used
 *     synthetic IDs of the form `admin_granted_<timestamp>_<rand>`. Tag those
 *     rows with source='admin_grant' AND rewrite the id into the new sentinel
 *     format `admin_grant_<_id>`. We do NOT strip the field, because the new
 *     unique index is non-sparse: leaving subscriptionId unset would collide
 *     across rows.
 *  3. Repair any admin_grant row that already has subscriptionId stripped
 *     (e.g. a previous run of the earlier migration variant). Give each one
 *     a sentinel based on its _id so the non-sparse unique index is satisfied.
 *  4. Backfill source='stripe' on the remainder (genuine Stripe-managed
 *     subscriptions) so the discriminator is populated everywhere.
 */

const LEGACY_ADMIN_GRANT_ID_RE = /^admin_granted_/;

const migration: MigrationFile = {
  id: 20260518120000,
  name: 'backfill-subscription-source',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const subscriptions = db.collection('subscriptions');

    // 1. Drop any sparse unique index on subscriptionId. The legacy non-sparse
    //    unique index matches the new schema and is kept.
    try {
      const indexes = await subscriptions.indexes();
      const sparseUnique = indexes.find(
        idx =>
          idx.key &&
          Object.keys(idx.key).length === 1 &&
          idx.key.subscriptionId === 1 &&
          idx.unique === true &&
          idx.sparse === true
      );
      if (sparseUnique?.name) {
        await subscriptions.dropIndex(sparseUnique.name);
        console.log(`✅ Dropped sparse unique index "${sparseUnique.name}" on subscriptionId`);
      } else {
        console.log('   No sparse unique index on subscriptionId — nothing to drop');
      }
    } catch (err) {
      // Drop can race with mongoose ensureIndexes on first deploy; log and continue.
      console.warn('   Warning while dropping sparse subscriptionId index:', err);
    }

    // 2. Tag legacy admin grants and rewrite their synthetic subscriptionId
    //    into the new sentinel format. Done as two ops because the regex
    //    filter cannot reference the matched doc; an aggregation-pipeline
    //    update would, but $rand/$toString availability is inconsistent
    //    across DocumentDB versions, so we iterate.
    const legacyCursor = subscriptions.find({ subscriptionId: { $regex: LEGACY_ADMIN_GRANT_ID_RE } });
    let legacyCount = 0;
    while (await legacyCursor.hasNext()) {
      const doc = await legacyCursor.next();
      if (!doc) break;
      await subscriptions.updateOne(
        { _id: doc._id },
        { $set: { source: 'admin_grant', subscriptionId: `admin_grant_${doc._id.toString()}` } }
      );
      legacyCount++;
    }
    console.log(
      `✅ Tagged ${legacyCount} legacy admin-granted rows as source='admin_grant' (subscriptionId rewritten)`
    );

    // 3. Repair admin_grant rows missing subscriptionId (from an earlier
    //    migration variant that stripped them).
    const repairCursor = subscriptions.find({
      source: 'admin_grant',
      $or: [{ subscriptionId: { $exists: false } }, { subscriptionId: null }],
    });
    let repairCount = 0;
    while (await repairCursor.hasNext()) {
      const doc = await repairCursor.next();
      if (!doc) break;
      await subscriptions.updateOne(
        { _id: doc._id },
        { $set: { subscriptionId: `admin_grant_${doc._id.toString()}` } }
      );
      repairCount++;
    }
    console.log(`✅ Repaired ${repairCount} admin_grant rows with missing subscriptionId`);

    // 4. Backfill the remainder as Stripe-managed.
    const stripeBackfill = await subscriptions.updateMany(
      { source: { $exists: false } },
      { $set: { source: 'stripe' } }
    );
    console.log(`✅ Backfilled source='stripe' on ${stripeBackfill.modifiedCount} Subscription rows`);
  },

  down: async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const subscriptions = db.collection('subscriptions');

    // Refuse to roll back if any admin_grant rows exist - those depend on the
    // sparse-unique index AND on consumers reading `source` to gate billing
    // portal access. Stripping the discriminator after the feature has gone
    // live would silently allow Stripe customer auto-creation for granted
    // orgs. Require an explicit cleanup before rollback.
    const adminGrants = await subscriptions.countDocuments({ source: 'admin_grant' });
    if (adminGrants > 0) {
      throw new Error(
        `Refusing to roll back: ${adminGrants} admin_grant Subscription rows exist. ` +
          `Revoke or convert them first (admin UI), then re-run the down migration.`
      );
    }

    // Best-effort rollback: clear the source field. We do not restore the
    // original `admin_granted_*` subscriptionIds - step 2 rewrote them
    // deterministically from each row's _id, but the system no longer relies
    // on that prefix once `source` is set, so this rollback is safe even
    // without restoring the old strings. The non-sparse unique index is
    // preserved either way.
    const result = await subscriptions.updateMany(
      { source: { $in: ['stripe', 'admin_grant'] } },
      { $unset: { source: '' } }
    );
    console.log(`Removed source field from ${result.modifiedCount} Subscription rows`);
  },
};

export default migration;

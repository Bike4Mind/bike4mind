import { AnalyticsUserDay } from '@bike4mind/database';
import { ACTIVE_SOURCES } from '@bike4mind/common';
import { type MigrationFile } from './index';

/**
 * Builds the { day, active, userId } index and sets `active` on analytics_user_days rows rolled up before
 * the field existed, so DAU/WAU/MAU and the active-window filter do not drop them between deploy and a
 * history rebuild. A row is active when it carries a first-party source, or no source at all (a legacy
 * event, which collectDayUsage also treats as active). Banned and AI-held accounts are only removed by
 * `backfill-analytics-rollup --force`, which stays the exact rebuild. Id backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), like its siblings.
 *
 * Idempotent: only rows with no `active` field are written, and createIndexes skips existing indexes.
 */
const migration: MigrationFile = {
  id: 20260921239800,
  name: 'backfill analytics user day active',

  up: async () => {
    await AnalyticsUserDay.createIndexes();
    const result = await AnalyticsUserDay.collection.updateMany({ active: { $exists: false } }, [
      {
        $set: {
          active: {
            $or: [
              { $eq: [{ $size: { $ifNull: ['$sources', []] } }, 0] },
              { $gt: [{ $size: { $setIntersection: [{ $ifNull: ['$sources', []] }, [...ACTIVE_SOURCES]] } }, 0] },
            ],
          },
        },
      },
    ]);
    console.log(`[backfill-analytics-user-day-active] set active on ${result.modifiedCount} row(s)`);
  },

  down: async () => {
    // The field is required by the schema now; unsetting it would drop those rows from DAU again.
  },
};

export default migration;

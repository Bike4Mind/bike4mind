import { OverwatchRawEvent, OverwatchUserDay } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build `{ userId: 1 }` on the Overwatch raw events and user-days, so account erasure
 * (server-utils eraseProductAnalyticsEvents) deletes one person's rows without scanning either
 * collection. `autoIndex` is off in the deployed environments. Named as the schema declares them,
 * so a later autoIndex is a no-op; idempotent, since createIndex is a no-op for a matching index.
 */
const migration: MigrationFile = {
  id: 20261124180550,
  name: 'ensure overwatch user id indexes',

  up: async () => {
    await OverwatchRawEvent.collection.createIndex({ userId: 1 }, { name: 'userId_1' });
    await OverwatchUserDay.collection.createIndex({ userId: 1 }, { name: 'userId_1' });
  },

  down: async () => {
    // Indexes are additive; dropping these would put every erasure back on a collection scan.
  },
};

export default migration;

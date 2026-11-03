import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * `setModerationStatus` used to mirror `isModerated: status === 'suspended'`. `isModerated` is now
 * the admin "Moderate" action's AI-only block and escalation no longer writes it, so a currently
 * suspended user's mirrored `true` would outlive the suspension and keep AI off after it is lifted.
 * Clear it on suspended users only: a `true` on any other status can only have come from an admin.
 *
 * Idempotent: the filter matches nothing once cleared. No `down`: the cleared value was derived
 * from `moderation.status`, which is untouched.
 */
const migration: MigrationFile = {
  id: 20260921235945,
  name: 'clear-suspension-mirrored-ismoderated',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('clear-suspension-mirrored-ismoderated: no database connection');
    const result = await db
      .collection('users')
      .updateMany({ 'moderation.status': 'suspended', isModerated: true }, { $set: { isModerated: false } });
    console.log(`[clear-suspension-mirrored-ismoderated] cleared isModerated on ${result.modifiedCount} user(s)`);
  },

  down: async () => {},
};

export default migration;

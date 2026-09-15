import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: backfill `hasUsablePassword` on existing user documents.
 *
 * `hasUsablePassword` is a new credential-state flag (see UserModel.ts) that the SSO
 * auto-link gate (verifyCallback.ts / okta/callback.ts) now reads instead of `!user.password`.
 * Every doc written before this migration lacks the field entirely, so the gate would
 * fail-open (treat every existing account as passwordless) without this backfill.
 *
 * SECURITY CAVEAT: admin/migration "shell" accounts (admin/create-user.ts,
 * reg-invites/migrate.ts) store an auto-generated `randomUUID()` password when no real
 * password is supplied - and once bcrypt-hashed, that value is INDISTINGUISHABLE from a
 * genuine password. So this backfill can only safely infer from password PRESENCE:
 * any non-empty `password` -> hasUsablePassword=true (matches pre-migration gate
 * behavior - these rows stay REFUSED by the SSO auto-link gate, same as before this
 * migration). This does NOT fix issue #44 for the existing admin-provisioned/migrated
 * cohort that has no real password - only NEWLY created accounts (which now set the
 * flag explicitly and correctly at creation) get the actual fix. Backfilling the
 * existing cohort would require a real signal this data doesn't have.
 *
 * Idempotent: both passes filter on `hasUsablePassword: { $exists: false }`, so
 * re-running touches nothing already stamped.
 */
const migration: MigrationFile = {
  id: 20260709120000,
  name: 'add-hasusablepassword-to-users',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const users = db.collection('users');

    const withPassword = await users.updateMany(
      { hasUsablePassword: { $exists: false }, password: { $exists: true, $type: 'string', $ne: '' } },
      { $set: { hasUsablePassword: true } }
    );

    // Everything left missing the field has no (or an empty) password.
    const withoutPassword = await users.updateMany(
      { hasUsablePassword: { $exists: false } },
      { $set: { hasUsablePassword: false } }
    );

    console.log(
      `[add-hasusablepassword-to-users] hasUsablePassword=true for ${withPassword.modifiedCount} password-bearing users, ` +
        `hasUsablePassword=false for ${withoutPassword.modifiedCount} passwordless users`
    );
  },

  down: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    await db.collection('users').updateMany({}, { $unset: { hasUsablePassword: '' } });
  },
};

export default migration;

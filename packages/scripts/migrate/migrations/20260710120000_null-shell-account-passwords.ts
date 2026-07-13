import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: null out leftover fake passwords on correctly-flagged shell accounts.
 *
 * Provisioning paths (admin/create-user.ts, admin/bulk-create-users.ts,
 * reg-invites/migrate.ts) historically stored an auto-generated password for
 * passwordless "shell" accounts while setting `hasUsablePassword: false`. That
 * stored hash is definitively junk (the flag authoritatively says the account has
 * no usable password), yet its mere presence could mislead any future
 * password-presence heuristic. This backfill aligns the stored data with the flag
 * by setting `password: null` on those accounts - matching what the provisioning
 * paths now write directly.
 *
 * Scoped to `emailVerified: false` on purpose. The one other path that writes
 * `hasUsablePassword: false` with a NON-junk password is the DB seeder
 * (packages/scripts/seeders/UserSeeder.ts), which stores a real shared secret
 * (usable via admin/emergency-login.ts) on `emailVerified: true` QA accounts.
 * Excluding verified accounts keeps this migration off the seeder's real password
 * while still covering the admin/migrate/bulk junk-password cohort, which is always
 * unverified. Self-registered and OAuth accounts already store `password: null`, so
 * the `$ne: ''` guard skips them too.
 *
 * SECURITY CAVEAT: this deliberately does NOT touch `hasUsablePassword: true` docs.
 * The stuck pre-existing cohort from issue #44 is exactly those docs, and they are
 * indistinguishable from genuine-password users (the flag was backfilled from the
 * same password-presence it was meant to disambiguate; there is no provisioning-
 * source marker on the user doc). Nulling passwords across that set would delete
 * real users' credentials, so it is out of scope here. That cohort recovers via the
 * existing admin action admin/users/[userId]/verify-email.ts (out-of-band identity
 * confirmation makes the SSO auto-link gate pass on the next sign-in) - NOT via a
 * bulk migration. This migration is data hygiene, not a recovery of that cohort.
 *
 * Idempotent: re-running matches nothing once the passwords are null.
 */
const migration: MigrationFile = {
  id: 20260710120000,
  name: 'null-shell-account-passwords',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const result = await db
      .collection('users')
      .updateMany(
        { hasUsablePassword: false, emailVerified: false, password: { $type: 'string', $ne: '' } },
        { $set: { password: null } }
      );

    console.log(
      `[null-shell-account-passwords] cleared leftover fake password on ${result.modifiedCount} passwordless shell accounts`
    );
  },

  // Irreversible: the removed values were random, unusable junk and must not be
  // recreated. Nulling them again on rollback would be a no-op, so down() does nothing.
  down: async () => {},
};

export default migration;

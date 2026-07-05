import { mongoose } from '@bike4mind/database';
import { GRANDFATHERED_POLICY_VERSION } from '@bike4mind/common';
import { type MigrationFile } from './index';

/**
 * Migration: grandfather existing accounts past the AUP/ToS acceptance gate.
 *
 * The consent-gate middleware (apps/client/server/auth/auth.ts) is fail-closed: it keys off the
 * ABSENCE of `aupAcceptedVersion` to decide "has not accepted policies" and blocks the account
 * from authenticated API surface. That is correct for NEW accounts, but every PRE-EXISTING user
 * also lacks the field - so without this backfill the middleware would trap the entire existing
 * user base on deploy.
 *
 * This stamps a distinguishable sentinel version (`GRANDFATHERED_POLICY_VERSION`) + acceptance
 * timestamp on all docs missing `aupAcceptedVersion`. The sentinel is queryable and clearly not a
 * real acceptance, so the fast-follow re-consent work can target grandfathered users. We do NOT
 * set `ageAttestedAdult` - these users never made an 18+ attestation, and fabricating one would
 * misrepresent the legal record (existing-user re-consent is explicitly out of scope).
 *
 * Idempotent: the filter matches only docs never stamped (field absent OR `null`), so re-running
 * touches nothing new and a genuinely-accepted account (`aupAcceptedVersion` a real/sentinel
 * string) is never rewritten. `UserModel` intentionally declares NO `default` on these fields, so
 * legacy docs keep the path ABSENT and `$exists: false` matches them. The extra `null` branch is
 * defense-in-depth: if any code path ever writes an explicit `null` (e.g. a future default, or a
 * spread that includes the key), those docs are still healed here rather than trapped.
 *
 * DEPLOY ORDERING: this migration must run with/before the enforcing middleware ships, or
 * existing users get trapped (annoying, not insecure - fail-closed).
 *
 * `down` is a no-op: reversing would delete legitimately-stamped grandfather records with no way
 * to distinguish them from real acceptances made after deploy. Consistent with sibling backfills.
 */
const migration: MigrationFile = {
  id: 20260702010000,
  name: 'backfill-policy-acceptance-grandfather',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const users = db.collection('users');
    const result = await users.updateMany(
      { $or: [{ aupAcceptedVersion: { $exists: false } }, { aupAcceptedVersion: null }] },
      { $set: { aupAcceptedVersion: GRANDFATHERED_POLICY_VERSION, aupAcceptedAt: new Date() } }
    );

    console.log(`[backfill-policy-acceptance-grandfather] grandfathered ${result.modifiedCount} existing users`);
  },

  down: async () => {
    // No-op: see header. Cannot safely distinguish migration-stamped sentinels from post-deploy
    // acceptances, so reversing risks deleting real acceptance records.
  },
};

export default migration;

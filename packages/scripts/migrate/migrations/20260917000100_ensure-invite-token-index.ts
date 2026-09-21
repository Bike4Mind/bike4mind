import { Invite, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the unique index behind the share-link bearer token.
 *
 * `resolveRedeemableInvite` resolves an invite from the token alone, so uniqueness is not a
 * performance hint here - it is the constraint that makes a single row the only possible answer.
 * The index is declared on InviteSchema, but autoIndex is off in the deployed environments, so
 * without this the constraint would simply not exist there.
 *
 * Declared PARTIAL rather than sparse: DocumentDB honours `unique` on a sparse index but not the
 * sparseness, so the legacy tokenless rows would all collide on the missing value. The drop below
 * clears the field-level `token_1` that an earlier revision of the schema built via autoIndex on
 * developer machines; it never existed in a deployed environment and `safeDropIndex` tolerates its
 * absence.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260917000100,
  name: 'ensure invite token unique index',

  up: async () => {
    await safeDropIndex(Invite.collection, 'token_1');
    await Invite.createIndexes();
  },

  down: async () => {
    // One-way. Dropping it would leave the token door resolving on an unconstrained field.
  },
};

export default migration;

import { safeDropIndex, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260730000000,
  name: 'add org-groups indexes (user.groups, group org+type live-unique)',

  up: async () => {
    // Build explicitly rather than leaning on autoIndex: `users` is a populated collection, and
    // these indexes back reads/writes added by org-groups #1172. Names MUST match the schema
    // declarations (UserModel.ts, GroupModel.ts) so autoIndex and this migration don't create the
    // same key pattern under two names (IndexKeySpecsConflict) - see the authProviders precedent.

    // user_groups: serves the group-list memberCount aggregation and the removeGroupsFromAllUsers
    // $pull on group-type revoke (both otherwise scan the full users collection).
    await User.collection.createIndex({ groups: 1 }, { name: 'user_groups' });
    console.log('✓ Created user_groups index');

    // group_org_type_live: one LIVE group per (organizationId, type) - the "one group per type per
    // org in v1" invariant. The partial filter scopes uniqueness to live rows so revoke
    // (soft-delete) then re-grant of the same type still succeeds.
    await User.db
      .collection('groups')
      .createIndex(
        { organizationId: 1, type: 1 },
        { unique: true, partialFilterExpression: { deletedAt: null }, name: 'group_org_type_live' }
      );
    console.log('✓ Created group_org_type_live index');
  },

  down: async () => {
    await safeDropIndex(User.collection, 'user_groups');
    await safeDropIndex(User.db.collection('groups'), 'group_org_type_live');
    console.log('✓ Dropped org-groups indexes');
  },
};

export default migration;

import { safeDropIndex, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260620000000,
  name: 'add non-unique multikey index on authProviders.(strategy, id)',

  up: async () => {
    // Adds a compound index on (authProviders.strategy, authProviders.id) to
    // support the two-stage OAuth lookup: stage-1 queries
    // $elemMatch { strategy, id } before falling back to email/username.
    //
    // NOT unique: legacy authProvider rows carry id:null; a unique multikey
    // would collide on every (strategy, null) pair. Cross-user uniqueness of
    // (strategy, id) is enforced in application logic.
    //
    // The name MUST match the schema declaration (UserModel.ts) so autoIndex
    // and this migration don't create the same key pattern under two names
    // (IndexKeySpecsConflict). Options are otherwise empty to mirror email_1.
    //
    // Drop any pre-existing index with the SAME key pattern under Mongoose's
    // auto-generated name first. An earlier build of this PR declared the schema
    // index without an explicit name, so autoIndex created
    // `authProviders.strategy_1_authProviders.id_1`; creating the canonical name
    // below would otherwise throw "Index already exists with a different name".
    // safeDropIndex is a no-op when the index is absent (clean staging/prod).
    await safeDropIndex(User.collection, 'authProviders.strategy_1_authProviders.id_1');

    await User.collection.createIndex(
      { 'authProviders.strategy': 1, 'authProviders.id': 1 },
      { name: 'authProviders_strategy_id' }
    );
    console.log('✓ Created authProviders_strategy_id index');
  },

  down: async () => {
    await safeDropIndex(User.collection, 'authProviders_strategy_id');
    console.log('✓ Dropped authProviders_strategy_id index');
  },
};

export default migration;

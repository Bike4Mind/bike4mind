import { safeDropIndex, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260619000000,
  name: 'convert user email unique index to partial (allow multiple emailless accounts)',

  up: async () => {
    // The plain unique index `email_1` treated every null/absent email as the
    // same value, so only ONE emailless account could exist. OAuth/SSO signups
    // without an email (e.g. a private GitHub email) collided with E11000 and
    // failed login. Recreate it as a PARTIAL unique index so uniqueness is
    // enforced only for real string emails; emailless docs are excluded.
    await safeDropIndex(User.collection, 'email_1');

    await User.collection.createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_1' }
    );
    console.log('✓ Recreated email_1 as a partial unique index');
  },

  down: async () => {
    // Intentional no-op. Recreating the plain (non-partial) unique index would
    // throw E11000 the moment more than one emailless account exists - which is
    // exactly the state this migration was created to allow. Restoring it would
    // also reintroduce the original bug. Same rationale as the down() no-op in
    // 20260529000000_datalake-org-scoped-slug-index.
  },
};

export default migration;

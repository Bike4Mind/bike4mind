import { UserApiKeyAuditLog } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the (actorUserId, createdAt, _id) index on UserApiKeyAuditLog.
 *
 * The admin per-user Activity view merges a user's own API key events into their timeline by keyset
 * page on actorUserId. The collection only had productId and keyId indexes, so that read would scan
 * it. `autoIndex` is off in deployed environments, so the schema declaration alone never builds.
 *
 * Idempotent: createIndexes is a no-op for indexes that already match.
 */
const migration: MigrationFile = {
  id: 20260921235944,
  name: 'ensure userapikeyauditlog actor index',

  up: async () => {
    await UserApiKeyAuditLog.createIndexes();
  },

  down: async () => {
    // One-way. The index is a read optimization; dropping it buys nothing.
  },
};

export default migration;

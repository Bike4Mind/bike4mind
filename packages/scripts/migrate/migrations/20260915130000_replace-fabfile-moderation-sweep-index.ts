import { FabFile, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop the superseded `{ moderationStatus: 1, deletedAt: 1, createdAt: 1 }` index on fabfiles and
 * build its replacement, `{ moderationStatus: 1, deletedAt: 1, moderationAttempts: 1, createdAt: 1 }`
 * (see FabFileModel.ts).
 *
 * The new key spec inserts `moderationAttempts` before `createdAt` rather than appending to it, so
 * it is not a superset of the old index - autoIndex would build it alongside the old one, not in
 * place of it, leaving the superseded index as dead weight paid on every FabFile write.
 *
 * `safeDropIndex` only swallows index-not-found, so the drop is a safe no-op where the old index is
 * already absent (a fresh environment that never built it). `down` is a no-op: recreating the
 * superseded index is not worth the foreground build.
 */
const migration: MigrationFile = {
  id: 20260915130000,
  name: 'replace fabfile moderation sweep index',

  up: async () => {
    await safeDropIndex(FabFile.collection, 'moderationStatus_1_deletedAt_1_createdAt_1');
    await FabFile.createIndexes();
  },

  down: async () => {},
};

export default migration;

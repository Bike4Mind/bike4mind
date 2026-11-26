import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the sparse `{ 'users.sessionId': 1 }` index exists on fabfiles.
 *
 * Session revoke and notebook delete find the rows a notebook minted by their session tag
 * (sharingService/revoke.ts, sessionService/delete.ts). Built here rather than left to autoIndex for
 * the reason 20260921235994_ensure-fabfile-owned-keyset-index gives.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20261126110800,
  name: 'ensure fabfile session tag index',

  up: async () => {
    await FabFile.createIndexes();
  },

  down: async () => {
    // Additive; dropping it would put those lookups back on a collection scan.
  },
};

export default migration;

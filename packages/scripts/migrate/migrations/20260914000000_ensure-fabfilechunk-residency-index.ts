import { FabFileChunk } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ fabFileId: 1, embeddingModel: 1, retrievalIndexConfirmedModel: 1 }` exists on
 * fabfilechunks.
 *
 * `annResidentFabFileIds` runs this aggregate on the self-host semantic search hot path (every
 * query, once residency is wired). Without the index it is a FETCH of every chunk document
 * (`vector` included) per file in the candidate set before the residency split even applies.
 *
 * Declared on the schema too, but a request-path index on the largest collection in the system
 * belongs in a migration rather than autoIndex: prod runs DocumentDB, where the build takes a
 * foreground lock, and autoIndex would take it lazily on a cold boot of whichever Lambda touches
 * the collection first. Same rationale as 20260728000000_ensure-fabfilechunk-keyset-index and
 * 20260907000000_ensure-fabfile-tagname-filename-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of FabFileChunk's other declared indexes an
 * environment happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260914000000,
  name: 'ensure fabfilechunk residency index',

  up: async () => {
    await FabFileChunk.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;

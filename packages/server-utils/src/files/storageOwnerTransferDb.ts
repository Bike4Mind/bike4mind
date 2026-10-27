import {
  memoryLedgerRepository,
  dataLakeRepository,
  fabFileRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';

/**
 * The repositories reassignStorageOwner (b4m-core/services/src/fabFileService/reassignStorageOwner.ts)
 * needs to move a file's billed bytes when its lake membership changes. Spread it into the `db` of
 * every service that adds or removes a `datalake:` meta-tag (addFileToDataLake, removeFileFromDataLake,
 * toggleTags, updateFabFile, cleanupDeletedDataLake, the ingest removals), next to
 * `lakeMembershipAuditDb`. Frozen for the same reason that one is: shared module state spread into
 * every write path.
 */
export const storageOwnerTransferDb = Object.freeze({
  memoryLedger: memoryLedgerRepository,
  fabFiles: fabFileRepository,
  dataLakes: dataLakeRepository,
  users: userRepository,
  organizations: organizationRepository,
});

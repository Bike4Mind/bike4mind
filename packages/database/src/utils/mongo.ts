// Facade: mongo utilities moved to @bike4mind/db-core
export type { InputRecordValue, OutputRecordValue, SoftDeletePluginOptions } from '@bike4mind/db-core';
export {
  isTransientTransactionError,
  connectDB,
  getDB,
  withTransaction,
  mongoExportedRecordConverter,
  findModelByCollectionName,
  softDeletePlugin,
  convertId,
  convertIds,
  compareMongoIds,
  safeDropIndex,
} from '@bike4mind/db-core';

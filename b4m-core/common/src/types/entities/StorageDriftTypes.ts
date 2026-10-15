import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * One storage reconciliation check of a user's `currentStorageSize` against the bytes their charged
 * files actually hold (apps/workers/src/cron/storageReconciliation.ts). Bytes throughout.
 */
export interface IStorageDriftRecord {
  userId: string;
  /** `currentStorageSize` as read immediately before computing truth. */
  counter: number;
  /** FabFileRepository.sumFileSizeByUserId at check time. */
  truth: number;
  /** counter - truth; positive means the user is charged for bytes they no longer hold. */
  drift: number;
  /** True when the counter was set to `truth`; false on a dry run, no drift, or a lost compare-and-set. */
  repaired: boolean;
  /** A concurrent charge or refund moved the counter between the read and the repair. */
  conflict: boolean;
  checkedAt: Date;
}

export type IStorageDriftRecordDocument = IStorageDriftRecord & IMongoDocument;

export interface IStorageDriftRecordRepository extends IBaseRepository<IStorageDriftRecordDocument> {
  appendMany(records: IStorageDriftRecord[]): Promise<void>;
  /** Each listed user's most recent record, keyed by userId; users never checked are absent. */
  latestByUserIds(userIds: string[]): Promise<Map<string, IStorageDriftRecord>>;
}

import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * One storage reconciliation check of a user's or organization's `currentStorageSize` against the bytes
 * of the files charged to them (apps/workers/src/cron/storageReconciliation.ts). Bytes throughout.
 * Exactly one of `userId` and `organizationId` is set.
 */
export interface IStorageDriftRecord {
  /** Set on user records. */
  userId?: string;
  /** Set on organization records. */
  organizationId?: string;
  /** `currentStorageSize` as read immediately before computing truth. */
  counter: number;
  /**
   * At check time: FabFileRepository.sumFileSizeByUserId (personal rows only) for user records,
   * sumFileSizeByOrganizationId for organization records.
   */
  truth: number;
  /** counter - truth; positive means the owner is charged for bytes it no longer holds. */
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
  /** Each listed organization's most recent record, keyed by organizationId; unchecked ones are absent. */
  latestByOrganizationIds(organizationIds: string[]): Promise<Map<string, IStorageDriftRecord>>;
}

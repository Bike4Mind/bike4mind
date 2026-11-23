import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Lake Config Snapshot --------------------------------------------------------------------
//
// The full values a History row must not carry. A config event is kept for years with no delete
// path, so it holds a feed address only in its redacted form. The working address, and the whole
// config of a deleted one, live here for a short window instead: long enough to undo a change,
// short enough that a token in a query string does not outlive the decision.

export const LAKE_CONFIG_SNAPSHOT_TTL_DAYS = 30;

export const LAKE_CONFIG_SNAPSHOT_KINDS = ['config-deleted', 'feed-url-edited'] as const;
export type LakeConfigSnapshotKind = (typeof LAKE_CONFIG_SNAPSHOT_KINDS)[number];

export const lakeConfigSnapshotExpiresAt = (now: Date): Date =>
  new Date(now.getTime() + LAKE_CONFIG_SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000);

export interface ILakeConfigSnapshot {
  dataLakeId: string;
  /** The config event the snapshot belongs to. Unique within the lake. */
  eventId: string;
  kind: LakeConfigSnapshotKind;
  /** The whole config as it stood before a delete. */
  config?: Record<string, unknown>;
  /** A feed edit's full addresses, null where that side had no feed. */
  feedUrlBefore?: string | null;
  feedUrlAfter?: string | null;
  expiresAt: Date;
}

export interface ILakeConfigSnapshotDocument extends ILakeConfigSnapshot, IMongoDocument {}

export interface ILakeConfigSnapshotRepository extends IBaseRepository<ILakeConfigSnapshotDocument> {
  record(input: ILakeConfigSnapshot): Promise<ILakeConfigSnapshotDocument>;
  /**
   * The unexpired snapshot for this event, or null. Filters `expiresAt` in the query: the TTL
   * sweep runs about once a minute, so an expired row can stay readable for a while.
   */
  findLive(dataLakeId: string, eventId: string, asOf?: Date): Promise<ILakeConfigSnapshotDocument | null>;
  deleteForLake(dataLakeId: string): Promise<number>;
}

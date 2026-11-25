import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Lake Config Undo Claim ------------------------------------------------------------------
//
// One row per History event that has been undone. The unique (dataLakeId, eventId) index is what
// makes "one undo per event" hold under concurrency, and the row's existence is the source of truth
// for "Undone": the History row an undo writes is best-effort and is never the guard. It covers both
// event streams, so `eventId` may name a config event or a membership event. Holds no user data.

export interface ILakeConfigUndoClaim {
  dataLakeId: string;
  /** The event that was undone. Unique within the lake. */
  eventId: string;
  /** The History row the undo wrote, once it is known. Absent when that row did not persist. */
  undoEventId?: string;
}

export interface ILakeConfigUndoClaimDocument extends ILakeConfigUndoClaim, IMongoDocument {}

export interface ILakeConfigUndoClaimRepository extends IBaseRepository<ILakeConfigUndoClaimDocument> {
  /** Insert the claim. False when one already exists, which is the "Already undone" answer. */
  claim(dataLakeId: string, eventId: string, undoEventId?: string): Promise<boolean>;
  /** Drop a claim so a refused or failed undo can be retried. */
  release(dataLakeId: string, eventId: string): Promise<void>;
  listForEvents(dataLakeId: string, eventIds: string[]): Promise<ILakeConfigUndoClaimDocument[]>;
  deleteForLake(dataLakeId: string): Promise<number>;
}

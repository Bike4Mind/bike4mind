import { IBaseRepository } from './BaseTypes';

/**
 * A WorkItem is a persistent unit of tracked work owned by a user. It is the
 * durable counterpart to the CLI's in-memory todo list: the CLI reads and
 * writes these through `/api/work-items`, so work survives a restart and
 * follows the user across machines.
 *
 * Items form a dependency DAG - `dependencies` holds the ids of items that
 * must close before this one can be started. Cycles are rejected at the API
 * layer on a best-effort basis (see `detectDependencyCycle`): the check reads
 * the graph and the write happens separately, so two concurrent writes can
 * still commit a cycle.
 */
export type WorkItemStatus = 'open' | 'in_progress' | 'blocked' | 'closed';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['open', 'in_progress', 'blocked', 'closed'];

export interface IWorkItem {
  id: string;
  userId: string;
  /**
   * Scaffolding for a future org-sharing feature. It can be set and filtered
   * on, but it grants nothing: every read path is hard-scoped to `userId`, so
   * an org-tagged item is still visible only to its owner.
   */
  organizationId?: string;
  title: string;
  description?: string;
  status: WorkItemStatus;
  /** Ids of WorkItems that must be closed before this one is actionable. */
  dependencies: string[];
  /** The loop this item is a ticket of. Loop tickets are hidden from plain listings unless filtered by loop. */
  loopId?: string;
  /** One of the loop's `stages`; the last stage means closed. Only set on loop tickets. */
  stage?: string;
  /** The loop run currently or last working this ticket. */
  executionId?: string;
  /** Why the ticket is `blocked`; cleared when it leaves `blocked`. */
  statusReason?: string;

  createdAt: Date;
  updatedAt: Date;
  /** When the item last transitioned to `closed`. Cleared if it is reopened. */
  closedAt?: Date;
  /** Soft-delete marker (softDeletePlugin). Distinct from `closedAt`: a closed
   *  item is finished work that still shows up; a deleted one is gone. */
  deletedAt?: Date;
}

/**
 * Mutable subset of a WorkItem. A `null` clears the field - the repository
 * translates it into a `$unset`, which a plain `undefined` in a `$set` could
 * not express. That is how `closedAt` is cleared when an item reopens, and how
 * `description` is cleared.
 */
export type WorkItemPatch = Partial<Pick<IWorkItem, 'title' | 'status' | 'dependencies' | 'organizationId'>> & {
  description?: string | null;
  closedAt?: Date | null;
  loopId?: string | null;
  stage?: string | null;
  statusReason?: string | null;
  executionId?: string | null;
};

export interface IWorkItemFilters {
  status?: WorkItemStatus[];
  organizationId?: string;
  /** Lists that loop's tickets. Without it, loop tickets are excluded. */
  loopId?: string;
  /** Case-insensitive substring match against title and description. */
  search?: string;
}

export interface IWorkItemGraphNode {
  id: string;
  title: string;
  status: WorkItemStatus;
}

/** `from` depends on `to`; `to` must close before `from` becomes ready. */
export interface IWorkItemGraphEdge {
  from: string;
  to: string;
}

export interface IWorkItemGraph {
  nodes: IWorkItemGraphNode[];
  edges: IWorkItemGraphEdge[];
  /**
   * Ids participating in a dependency cycle. The API rejects cycles on a
   * best-effort basis only (the check and the write are not atomic), and a
   * direct DB write bypasses it entirely, so this is reported rather than
   * assumed empty - a cycle silently starves `ready`.
   */
  cycles: string[];
  /**
   * The user has more live items than the whole-graph read window, so edges
   * and cycles are computed from a prefix. Answers derived from it can be
   * wrong: a blocker outside the window reads as satisfied.
   */
  truncated: boolean;
}

/** `truncated` carries the same caveat as on IWorkItemGraph. */
export interface IWorkItemReadyResult {
  data: IWorkItem[];
  truncated: boolean;
}

export interface IWorkItemRepository extends IBaseRepository<IWorkItem> {
  /** Paginated listing of the user's live items. */
  listForUser(
    userId: string,
    filters: IWorkItemFilters,
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt' | 'title'; direction: 'asc' | 'desc' }
    // Explicit return type: declaration emit otherwise expands IWorkItem into
    // union members that are not exported from @bike4mind/common's entry (TS4053).
  ): Promise<{ data: IWorkItem[]; hasMore: boolean; total: number }>;

  findByIdForUser(id: string, userId: string): Promise<IWorkItem | null>;

  /** Batched ownership check used to validate a `dependencies` payload. */
  findManyByIdsForUser(ids: string[], userId: string): Promise<IWorkItem[]>;

  /**
   * Items with status `open` whose every dependency is closed or no longer
   * exists. `in_progress` (already picked up) and `blocked` (held back
   * deliberately) are excluded, so this answers "what can I start now".
   * Plain items only, unless `loopId` asks for that loop's tickets instead.
   */
  listReadyForUser(userId: string, loopId?: string): Promise<IWorkItemReadyResult>;

  buildGraphForUser(userId: string): Promise<IWorkItemGraph>;

  /**
   * Scoped update - returns null when the item is missing or owned by someone else. With `expectedStatus`
   * it only applies while the item still has that status, so a loop's fold landing mid-request is not overwritten.
   */
  updateForUser(
    id: string,
    userId: string,
    patch: WorkItemPatch,
    expectedStatus?: WorkItemStatus
  ): Promise<IWorkItem | null>;

  /** Soft delete. Returns false when nothing matched. */
  softDeleteForUser(id: string, userId: string): Promise<boolean>;

  /**
   * The oldest `open` ticket of the loop, outside `lastStage`, whose dependencies are all closed or
   * gone. This is what the loop scheduler works next.
   */
  findNextReadyForLoop(userId: string, loopId: string, lastStage: string): Promise<IWorkItem | null>;

  /** `open -> in_progress`, conditional on still being `open`; null when another tick won the claim. */
  claimForRun(id: string, loopId: string): Promise<IWorkItem | null>;

  setExecution(id: string, executionId: string): Promise<void>;

  /** Undoes `claimForRun` when the run could not be started. */
  releaseClaim(id: string): Promise<void>;

  findByExecutionId(executionId: string): Promise<IWorkItem | null>;

  /**
   * Applies a finished run's outcome, conditional on the ticket still being `in_progress` under that
   * run - so a run that set its own ticket's status is respected and a second fold is a no-op.
   */
  foldTicketRun(id: string, executionId: string, patch: WorkItemPatch): Promise<boolean>;

  /** Moves a ticket blocked under `executionId` back to `in_progress`, for a run its owner resumed. */
  resumeBlockedRun(id: string, executionId: string): Promise<boolean>;

  /** A loop's live tickets: every non-closed one plus the `closedLimit` most recently closed. */
  listForLoop(userId: string, loopId: string, closedLimit: number): Promise<IWorkItem[]>;

  softDeleteByLoop(userId: string, loopId: string): Promise<number>;

  /** Live blocked tickets per loop id; loops with none are absent. */
  countBlockedByLoop(userId: string, loopIds: string[]): Promise<Record<string, number>>;

  /**
   * True when pointing `itemId` at `dependencies` would close a cycle. `itemId`
   * is undefined for a not-yet-created item, which can only cycle if the
   * proposed dependencies already cycle among themselves.
   */
  detectDependencyCycle(userId: string, dependencies: string[], itemId?: string): Promise<boolean>;
}

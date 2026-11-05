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

/** A loop ticket's priority, p0 most urgent. The values sort lexically in priority order. */
export const WORK_ITEM_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];
/** What a loop ticket without a `priority` reads as. The create paths and the scheduler's query share it. */
export const DEFAULT_WORK_ITEM_PRIORITY: WorkItemPriority = 'p2';

/** Sort key for a priority; a missing one ranks as the default. */
export const workItemPriorityRank = (priority?: WorkItemPriority): number =>
  WORK_ITEM_PRIORITIES.indexOf(priority ?? DEFAULT_WORK_ITEM_PRIORITY);

/**
 * Who last set a loop ticket's priority. Only an `owner` priority is sticky: the scheduler's p2 cap may demote an
 * agent-set p2 to p3 (`demote`), never an owner-set one.
 */
export const WORK_ITEM_PRIORITY_SETTERS = ['owner', 'agent', 'demote'] as const;
export type WorkItemPrioritySetter = (typeof WORK_ITEM_PRIORITY_SETTERS)[number];

/** Conditions the loop scheduler can test, so a ticket blocked on one reopens on its own once it holds. */
export const WORK_ITEM_BLOCKERS = ['dependencies'] as const;
export type WorkItemBlocker = (typeof WORK_ITEM_BLOCKERS)[number];

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
  /** Loop runs that claimed this ticket since its owner last moved it; the scheduler blocks it at its limit. */
  runCount?: number;
  /**
   * Loop tickets only. Absent means untriaged: the scheduler never picks such a ticket and a triage run sets
   * it. Display-only callers rank a missing one as DEFAULT_WORK_ITEM_PRIORITY.
   */
  priority?: WorkItemPriority;
  /** Set with every `priority` write (`priorityPatch` in apps/client/server/utils/loopTickets.ts); starts the service-level clock. */
  prioritySetAt?: Date;
  prioritySetBy?: WorkItemPrioritySetter;
  /** Split into child tickets (its `dependencies`); parked on them and closed by the scheduler once they all close. */
  epic?: boolean;
  /**
   * Set only while `blocked` on a condition the scheduler tests each tick; it reopens the ticket once the
   * condition holds. A block without it is a human one and is never reopened automatically.
   */
  blockedOn?: WorkItemBlocker;

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
  priority?: WorkItemPriority | null;
  prioritySetAt?: Date | null;
  prioritySetBy?: WorkItemPrioritySetter | null;
  epic?: boolean | null;
  blockedOn?: WorkItemBlocker | null;
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
   * `guard` narrows that further to an exact `statusReason` and/or `loopId`.
   */
  updateForUser(
    id: string,
    userId: string,
    patch: WorkItemPatch,
    expectedStatus?: WorkItemStatus,
    guard?: { statusReason?: string; loopId?: string }
  ): Promise<IWorkItem | null>;

  /** Soft delete. Returns false when nothing matched. */
  softDeleteForUser(id: string, userId: string): Promise<boolean>;

  /**
   * The first of `listReadyForLoop`: the ticket the loop scheduler works next.
   */
  findNextReadyForLoop(
    userId: string,
    loopId: string,
    stages: string[],
    skipStages?: string[]
  ): Promise<IWorkItem | null>;

  /**
   * The loop's `open` tickets outside its last stage and `skipStages` (desktop stages) whose dependencies
   * are all closed or gone: highest priority first, then furthest stage, then oldest.
   */
  listReadyForLoop(
    userId: string,
    loopId: string,
    stages: string[],
    skipStages?: string[],
    opts?: { onlyPriorities?: WorkItemPriority[] }
  ): Promise<IWorkItem[]>;

  /** The loop's open, non-epic tickets with no priority (any stage), oldest first: what a triage run sets. */
  listUntriagedForLoop(userId: string, loopId: string, limit: number): Promise<IWorkItem[]>;

  /** Sets a p2 that its owner did not set to p3 (`prioritySetBy: 'demote'`); false when it no longer matched. */
  demoteIfAgentSet(id: string, now: Date): Promise<boolean>;

  /** Live p0/p1 loop tickets that are open, in progress or blocked, across all users: the service-level sweep. */
  listUrgentForLoops(limit: number): Promise<IWorkItem[]>;

  /** `open -> in_progress`, conditional on still being `open`; null when another tick won the claim. */
  claimForRun(id: string, loopId: string): Promise<IWorkItem | null>;

  /** `listReadyForLoop`'s order, over the loop's tickets in `inStages` only (desktop stages); never its last stage. */
  listReadyInStages(userId: string, loopId: string, stages: string[], inStages: string[]): Promise<IWorkItem[]>;

  /**
   * A desktop runner's claim: `open -> in_progress` under `executionId` (its run) in one write, conditional
   * on the ticket still being `open` in one of `inStages`; null when another claim won or the stage moved.
   */
  claimForRunner(
    id: string,
    userId: string,
    loopId: string,
    inStages: string[],
    executionId: string
  ): Promise<IWorkItem | null>;

  /** Count of the loop's tickets created or updated in [from, to]. */
  countTouchedForLoop(userId: string, loopId: string, from: Date, to: Date): Promise<number>;

  setExecution(id: string, executionId: string): Promise<void>;

  /** Undoes `claimForRun` (its `runCount` increment too) when the run could not be started. */
  releaseClaim(id: string): Promise<void>;

  findByExecutionId(executionId: string): Promise<IWorkItem | null>;

  /** Loop tickets `in_progress` across all users, least recently updated first. */
  listInProgressForLoops(limit: number): Promise<IWorkItem[]>;

  /**
   * Reopens a stranded loop ticket (uncounted, like `releaseClaim`), conditional on it still being `in_progress`
   * under `executionId` (or under none when undefined). False when it was not.
   */
  releaseStranded(id: string, executionId?: string): Promise<boolean>;

  /**
   * Applies a finished run's outcome, conditional on the ticket still being `in_progress` under that
   * run - so a run that set its own ticket's status is respected and a second fold is a no-op.
   * `uncount` takes back the claim's `runCount` increment, for a run stopped by credits, not by the ticket.
   */
  foldTicketRun(id: string, executionId: string, patch: WorkItemPatch, uncount?: boolean): Promise<boolean>;

  /** Moves a ticket blocked under `executionId` back to `in_progress`, for a run its owner resumed. */
  resumeBlockedRun(id: string, executionId: string): Promise<boolean>;

  /** A loop's live tickets: every non-closed one plus the `closedLimit` most recently closed. */
  listForLoop(userId: string, loopId: string, closedLimit: number): Promise<IWorkItem[]>;

  softDeleteByLoop(userId: string, loopId: string): Promise<number>;

  /**
   * Reopens up to `limit` tickets (across all users) parked with `blockedOn: 'dependencies'` whose dependencies
   * are all closed or gone. Only status, statusReason and blockedOn change; runCount and executionId are kept.
   * An `epic` is closed in its loop's last stage instead (a deleted loop keeps it parked).
   * Returns the reopened and closed tickets.
   */
  reopenSatisfiedBlocks(limit: number): Promise<IWorkItem[]>;

  /** Live blocked tickets per loop id, minus those parked on a `blockedOn` condition; loops with none are absent. */
  countBlockedByLoop(userId: string, loopIds: string[]): Promise<Record<string, number>>;

  /**
   * True when pointing `itemId` at `dependencies` would close a cycle. `itemId`
   * is undefined for a not-yet-created item, which can only cycle if the
   * proposed dependencies already cycle among themselves.
   */
  detectDependencyCycle(userId: string, dependencies: string[], itemId?: string): Promise<boolean>;
}

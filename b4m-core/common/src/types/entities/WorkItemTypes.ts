import { IBaseRepository } from './BaseTypes';

/**
 * A WorkItem is a persistent unit of tracked work owned by a user. It is the
 * durable counterpart to the CLI's in-memory todo list: the CLI reads and
 * writes these through `/api/work-items`, so work survives a restart and
 * follows the user across machines.
 *
 * Items form a dependency DAG - `dependencies` holds the ids of items that
 * must close before this one can be started. Cycles are rejected at the API
 * layer (see `detectDependencyCycle`), otherwise nothing would ever be ready.
 */
export type WorkItemStatus = 'open' | 'in_progress' | 'blocked' | 'closed';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['open', 'in_progress', 'blocked', 'closed'];

export interface IWorkItem {
  id: string;
  userId: string;
  /** Set when the item belongs to an organization rather than to the user alone. */
  organizationId?: string;
  title: string;
  description?: string;
  status: WorkItemStatus;
  /** Ids of WorkItems that must be closed before this one is actionable. */
  dependencies: string[];

  createdAt: Date;
  updatedAt: Date;
  /** When the item last transitioned to `closed`. Cleared if it is reopened. */
  closedAt?: Date;
  /** Soft-delete marker (softDeletePlugin). Distinct from `closedAt`: a closed
   *  item is finished work that still shows up; a deleted one is gone. */
  deletedAt?: Date;
}

/**
 * Mutable subset of a WorkItem. `closedAt: null` clears the timestamp (the item
 * was reopened) - the repository translates it into a `$unset`, which a plain
 * `undefined` in a `$set` could not express.
 */
export type WorkItemPatch = Partial<
  Pick<IWorkItem, 'title' | 'description' | 'status' | 'dependencies' | 'organizationId'>
> & {
  closedAt?: Date | null;
};

export interface IWorkItemFilters {
  status?: WorkItemStatus[];
  organizationId?: string;
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
   * Ids participating in a dependency cycle. Always empty for graphs built
   * only through the API (which rejects cycles), but reported so a graph made
   * cyclic by older data or a direct DB write is visible rather than silently
   * starving `ready`.
   */
  cycles: string[];
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
   */
  listReadyForUser(userId: string): Promise<IWorkItem[]>;

  buildGraphForUser(userId: string): Promise<IWorkItemGraph>;

  /** Scoped update - returns null when the item is missing or owned by someone else. */
  updateForUser(id: string, userId: string, patch: WorkItemPatch): Promise<IWorkItem | null>;

  /** Soft delete. Returns false when nothing matched. */
  softDeleteForUser(id: string, userId: string): Promise<boolean>;

  /**
   * True when pointing `itemId` at `dependencies` would close a cycle. `itemId`
   * is undefined for a not-yet-created item, which can only cycle if the
   * proposed dependencies already cycle among themselves.
   */
  detectDependencyCycle(userId: string, dependencies: string[], itemId?: string): Promise<boolean>;
}

import mongoose, { Model, Schema, model } from 'mongoose';
import {
  IWorkItem,
  IWorkItemFilters,
  IWorkItemGraph,
  IWorkItemGraphEdge,
  IWorkItemReadyResult,
  IWorkItemRepository,
  WORK_ITEM_STATUSES,
  WorkItemPatch,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { softDeletePlugin } from '../../utils/mongo';

const ModelName = 'WorkItem';

/**
 * Ceiling on the number of items pulled into memory for the whole-graph
 * operations (`ready`, `graph`). Both need every live item to resolve
 * dependencies, so they cannot be paginated; the cap keeps a runaway backlog
 * from blowing the Lambda's memory. A dependency outside the window reads as
 * "no longer exists", i.e. satisfied, so a truncated read can report an item
 * ready while a live blocker is still open, and can miss a cycle routed through
 * an out-of-window item. Truncation is therefore surfaced to the caller
 * (`truncated`) rather than hidden.
 */
export const MAX_GRAPH_ITEMS = 2000;

export interface IWorkItemModel extends Model<IWorkItem> {}

export class WorkItemRepository extends BaseRepository<IWorkItem> implements IWorkItemRepository {
  constructor(private workItemModel: IWorkItemModel) {
    super(workItemModel);
    this.workItemModel = workItemModel;
  }

  async listForUser(
    userId: string,
    filters: IWorkItemFilters,
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt' | 'title'; direction: 'asc' | 'desc' }
  ): Promise<{ data: IWorkItem[]; hasMore: boolean; total: number }> {
    const conditions = this.liveScope(userId, filters);

    const total = await this.workItemModel.countDocuments(conditions);

    const result = await this.workItemModel
      .find(conditions)
      .sort({ [orderBy.by]: orderBy.direction === 'asc' ? 1 : -1 })
      .skip((pagination.page - 1) * pagination.limit)
      .limit(pagination.limit + 1)
      .exec();

    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    return { data: result.map(doc => doc.toJSON()), hasMore, total };
  }

  async findByIdForUser(id: string, userId: string): Promise<IWorkItem | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.workItemModel.findOne({ _id: id, userId, deletedAt: null });
    return result?.toJSON() ?? null;
  }

  async findManyByIdsForUser(ids: string[], userId: string): Promise<IWorkItem[]> {
    const valid = ids.filter(id => mongoose.isValidObjectId(id));
    if (valid.length === 0) return [];
    const results = await this.workItemModel.find({ _id: { $in: valid }, userId, deletedAt: null });
    return results.map(doc => doc.toJSON());
  }

  async listReadyForUser(userId: string): Promise<IWorkItemReadyResult> {
    const { items, truncated } = await this.loadAllForUser(userId);
    const statusById = new Map(items.map(item => [item.id, item.status]));

    const data = items.filter(
      item =>
        item.status === 'open' &&
        item.dependencies.every(depId => {
          const depStatus = statusById.get(depId);
          // An unknown dependency was deleted (or is outside MAX_GRAPH_ITEMS);
          // treat it as satisfied rather than blocking the item forever.
          return depStatus === undefined || depStatus === 'closed';
        })
    );

    return { data, truncated };
  }

  async buildGraphForUser(userId: string): Promise<IWorkItemGraph> {
    const { items, truncated } = await this.loadAllForUser(userId);
    const known = new Set(items.map(item => item.id));

    const edges: IWorkItemGraphEdge[] = [];
    for (const item of items) {
      for (const depId of item.dependencies) {
        if (known.has(depId)) edges.push({ from: item.id, to: depId });
      }
    }

    return {
      nodes: items.map(item => ({ id: item.id, title: item.title, status: item.status })),
      edges,
      cycles: findCycleMembers(items.map(item => ({ id: item.id, dependencies: item.dependencies }))),
      truncated,
    };
  }

  async updateForUser(id: string, userId: string, patch: WorkItemPatch): Promise<IWorkItem | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    // A `null` in the patch means "clear this field", which only $unset can do.
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) unset[key] = '';
      else if (value !== undefined) set[key] = value;
    }

    const result = await this.workItemModel.findOneAndUpdate(
      { _id: id, userId, deletedAt: null },
      {
        ...(Object.keys(set).length > 0 && { $set: set }),
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
      },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async softDeleteForUser(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.workItemModel.updateOne(
      { _id: id, userId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  async detectDependencyCycle(userId: string, dependencies: string[], itemId?: string): Promise<boolean> {
    if (dependencies.length === 0) return false;

    const { items } = await this.loadAllForUser(userId);
    const adjacency = new Map(items.map(item => [item.id, item.dependencies]));
    // Overlay the proposed edges so the check runs against the post-write graph.
    adjacency.set(itemId ?? PROPOSED_NODE_ID, dependencies);

    const nodes = Array.from(adjacency, ([id, deps]) => ({ id, dependencies: deps }));
    const cyclic = new Set(findCycleMembers(nodes));
    return cyclic.has(itemId ?? PROPOSED_NODE_ID);
  }

  private liveScope(userId: string, filters: IWorkItemFilters): Record<string, unknown> {
    const conditions: Record<string, unknown> = { userId, deletedAt: null };

    if (filters.status && filters.status.length > 0) {
      conditions.status = { $in: filters.status };
    }
    if (filters.organizationId) {
      conditions.organizationId = filters.organizationId;
    }
    if (filters.search) {
      // Escape metacharacters: `search` comes straight off the query string, and
      // a pattern like `(a+)+$` would hang the Lambda on backtracking.
      const escaped = escapeRegex(filters.search);
      conditions.$or = [
        { title: { $regex: escaped, $options: 'si' } },
        { description: { $regex: escaped, $options: 'si' } },
      ];
    }

    return conditions;
  }

  private async loadAllForUser(userId: string): Promise<{ items: IWorkItem[]; truncated: boolean }> {
    const results = await this.workItemModel
      .find({ userId, deletedAt: null })
      .sort({ createdAt: 1 })
      .limit(MAX_GRAPH_ITEMS);
    return { items: results.map(doc => doc.toJSON()), truncated: results.length === MAX_GRAPH_ITEMS };
  }
}

/** Stand-in node id for a dependency set proposed by a create that has no id yet. */
const PROPOSED_NODE_ID = '__proposed__';

/**
 * Ids that sit on a dependency cycle, via iterative DFS with a colouring
 * (white/grey/black) so a deep chain can't overflow the stack. Every member of
 * every cycle is reported, not just the back-edge target, so a caller can show
 * the whole knot.
 */
function findCycleMembers(nodes: Array<{ id: string; dependencies: string[] }>): string[] {
  const adjacency = new Map(nodes.map(node => [node.id, node.dependencies]));
  const state = new Map<string, 'grey' | 'black'>();
  const cyclic = new Set<string>();

  for (const node of nodes) {
    if (state.has(node.id)) continue;

    const path: string[] = [];
    const stack: Array<{ id: string; nextIndex: number }> = [{ id: node.id, nextIndex: 0 }];
    state.set(node.id, 'grey');
    path.push(node.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = adjacency.get(frame.id) ?? [];

      if (frame.nextIndex >= deps.length) {
        state.set(frame.id, 'black');
        stack.pop();
        path.pop();
        continue;
      }

      const next = deps[frame.nextIndex++];
      if (!adjacency.has(next)) continue;

      if (state.get(next) === 'grey') {
        // Back edge: everything from `next` to the top of the path is on the cycle.
        for (let i = path.lastIndexOf(next); i < path.length; i++) cyclic.add(path[i]);
        continue;
      }
      if (state.get(next) === 'black') continue;

      state.set(next, 'grey');
      path.push(next);
      stack.push({ id: next, nextIndex: 0 });
    }
  }

  return Array.from(cyclic);
}

export const WorkItemSchema = new Schema<IWorkItem, IWorkItemModel>(
  {
    userId: { type: String, required: true },
    // Scaffolding for a future org-sharing feature: settable and filterable,
    // but it grants no access - every read path is hard-scoped to userId.
    organizationId: { type: String },
    title: { type: String, required: true, maxlength: 300 },
    description: { type: String, maxlength: 10_000 },
    status: { type: String, enum: WORK_ITEM_STATUSES, required: true, default: 'open' },
    dependencies: { type: [String], default: [] },
    closedAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

WorkItemSchema.plugin(softDeletePlugin);

// Per CLAUDE.md MongoDB guideline: all performance indexes declared together at
// the bottom, never as `index: true` on field definitions.
WorkItemSchema.index({ userId: 1, deletedAt: 1, status: 1 });
WorkItemSchema.index({ userId: 1, deletedAt: 1, updatedAt: -1 });

export const WorkItem: IWorkItemModel =
  (mongoose.models[ModelName] as unknown as IWorkItemModel) ??
  model<IWorkItem, IWorkItemModel>(ModelName, WorkItemSchema);

export const workItemRepository = new WorkItemRepository(WorkItem);

export default WorkItem;

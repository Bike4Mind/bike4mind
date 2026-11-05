import mongoose, { Model, Schema, model } from 'mongoose';
import {
  IWorkItem,
  IWorkItemFilters,
  IWorkItemGraph,
  IWorkItemGraphEdge,
  IWorkItemReadyResult,
  IWorkItemRepository,
  WORK_ITEM_BLOCKERS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_PRIORITY_SETTERS,
  WorkItemPriority,
  WORK_ITEM_STATUSES,
  WorkItemPatch,
  WorkItemStatus,
  workItemPriorityRank,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { softDeletePlugin } from '../../utils/mongo';
import { Loop } from './LoopModel';

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

/**
 * ponytail: candidate window for `listReadyForLoop`, cut after the priority sort and before the dependency
 * filter. Lower priorities starve only while 200+ higher-or-equal open tickets fill it (even ones still waiting on
 * open deps), and finish-first applies within the window.
 */
const LOOP_READY_CANDIDATES = 200;

/** ponytail: pages of parked tickets `reopenSatisfiedBlocks` reads per call; ones further on wait until earlier ones move. */
const REOPEN_SCAN_PAGES = 25;

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

  async listReadyForUser(userId: string, loopId?: string): Promise<IWorkItemReadyResult> {
    // Closed loop tickets pile up; leaving them out keeps them from crowding plain items out of the
    // window, and a missing dependency already counts as satisfied below.
    const { items, truncated } = await this.loadAllForUser(userId, { skipClosedLoopTickets: true });
    const statusById = new Map(items.map(item => [item.id, item.status]));

    // Readiness is computed over every item so a dependency on a loop ticket is honoured, but loop
    // tickets themselves are worked by their loop, so they show only when asked for by loopId.
    const data = items.filter(
      item =>
        (loopId ? item.loopId === loopId : !item.loopId) &&
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

  async findNextReadyForLoop(
    userId: string,
    loopId: string,
    stages: string[],
    skipStages: string[] = []
  ): Promise<IWorkItem | null> {
    return (await this.listReadyForLoop(userId, loopId, stages, skipStages))[0] ?? null;
  }

  /**
   * A loop's open tickets whose dependencies are closed, in the order its runs take them: highest priority,
   * then finish first (a later stage before an earlier one), then oldest first.
   */
  async listReadyForLoop(
    userId: string,
    loopId: string,
    stages: string[],
    skipStages: string[] = [],
    opts: { onlyPriorities?: WorkItemPriority[] } = {}
  ): Promise<IWorkItem[]> {
    return this.listReady(userId, loopId, stages, { $nin: [stages.at(-1) ?? '', ...skipStages] }, opts.onlyPriorities);
  }

  async listUntriagedForLoop(userId: string, loopId: string, limit: number): Promise<IWorkItem[]> {
    const results = await this.workItemModel
      .find({ userId, loopId, deletedAt: null, status: 'open', priority: { $exists: false }, epic: { $ne: true } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async demoteIfAgentSet(id: string, now: Date): Promise<boolean> {
    const result = await this.workItemModel.updateOne(
      { _id: id, priority: 'p2', prioritySetBy: { $ne: 'owner' }, deletedAt: null },
      { $set: { priority: 'p3', prioritySetAt: now, prioritySetBy: 'demote' } }
    );
    return result.modifiedCount > 0;
  }

  async listUrgentForLoops(limit: number): Promise<IWorkItem[]> {
    const results = await this.workItemModel
      .find({
        priority: { $in: ['p0', 'p1'] },
        status: { $in: ['open', 'in_progress', 'blocked'] },
        loopId: { $exists: true },
        deletedAt: null,
      })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listReadyInStages(userId: string, loopId: string, stages: string[], inStages: string[]): Promise<IWorkItem[]> {
    const last = stages.at(-1);
    return this.listReady(userId, loopId, stages, { $in: inStages.filter(stage => stage !== last) });
  }

  private async listReady(
    userId: string,
    loopId: string,
    stages: string[],
    stageFilter: Record<string, string[]>,
    onlyPriorities?: WorkItemPriority[]
  ): Promise<IWorkItem[]> {
    // Stages are filtered and priority is sorted in the query, so neither excluded stages nor a backlog of
    // lower-priority tickets can push a p0 out of the candidate window. An untriaged ticket (no priority) waits
    // for its triage run.
    const docs = await this.workItemModel.aggregate([
      {
        $match: {
          userId,
          loopId,
          deletedAt: null,
          status: 'open',
          stage: stageFilter,
          priority: onlyPriorities ? { $in: onlyPriorities } : { $exists: true },
        },
      },
      { $sort: { priority: 1, createdAt: 1 } },
      { $limit: LOOP_READY_CANDIDATES },
    ]);
    const candidates: IWorkItem[] = docs.map(doc => this.workItemModel.hydrate(doc).toJSON());
    const depIds = [...new Set(candidates.flatMap(item => item.dependencies))];
    const deps = await this.findManyByIdsForUser(depIds, userId);
    const open = new Set(deps.filter(dep => dep.status !== 'closed').map(dep => dep.id));
    const stageIndex = (item: IWorkItem) => stages.indexOf(item.stage ?? '');
    // Array.prototype.sort is stable, so equal keys keep the createdAt order.
    return candidates
      .filter(item => item.dependencies.every(depId => !open.has(depId)))
      .sort(
        (a, b) => workItemPriorityRank(a.priority) - workItemPriorityRank(b.priority) || stageIndex(b) - stageIndex(a)
      );
  }

  async claimForRun(id: string, loopId: string): Promise<IWorkItem | null> {
    const result = await this.workItemModel.findOneAndUpdate(
      { _id: id, loopId, deletedAt: null, status: 'open' },
      { $set: { status: 'in_progress' }, $inc: { runCount: 1 } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async claimForRunner(
    id: string,
    userId: string,
    loopId: string,
    inStages: string[],
    executionId: string
  ): Promise<IWorkItem | null> {
    const result = await this.workItemModel.findOneAndUpdate(
      { _id: id, userId, loopId, deletedAt: null, status: 'open', stage: { $in: inStages } },
      { $set: { status: 'in_progress', executionId }, $inc: { runCount: 1 } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  /** Tickets of a loop created or changed in [from, to]; a run that touched none changed nothing on the board. */
  async countTouchedForLoop(userId: string, loopId: string, from: Date, to: Date): Promise<number> {
    return this.workItemModel.countDocuments({ userId, loopId, updatedAt: { $gte: from, $lte: to } });
  }

  async setExecution(id: string, executionId: string): Promise<void> {
    await this.workItemModel.updateOne({ _id: id }, { $set: { executionId } });
  }

  async releaseClaim(id: string): Promise<void> {
    await this.workItemModel.updateOne(
      { _id: id, status: 'in_progress' },
      { $set: { status: 'open' }, $unset: { executionId: '' }, $inc: { runCount: -1 } }
    );
  }

  async listInProgressForLoops(limit: number): Promise<IWorkItem[]> {
    const results = await this.workItemModel
      .find({ status: 'in_progress', loopId: { $exists: true }, deletedAt: null })
      .sort({ updatedAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async releaseStranded(id: string, executionId?: string): Promise<boolean> {
    const result = await this.workItemModel.updateOne(
      { _id: id, status: 'in_progress', executionId: executionId ?? { $exists: false } },
      { $set: { status: 'open' }, $unset: { executionId: '' }, $inc: { runCount: -1 } }
    );
    return result.modifiedCount > 0;
  }

  async findByExecutionId(executionId: string): Promise<IWorkItem | null> {
    const result = await this.workItemModel.findOne({ executionId, deletedAt: null });
    return result?.toJSON() ?? null;
  }

  async foldTicketRun(id: string, executionId: string, patch: WorkItemPatch, uncount = false): Promise<boolean> {
    const { set, unset } = splitPatch(patch);
    const result = await this.workItemModel.updateOne(
      { _id: id, executionId, status: 'in_progress', deletedAt: null },
      {
        ...(Object.keys(set).length > 0 && { $set: set }),
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
        ...(uncount && { $inc: { runCount: -1 } }),
      }
    );
    return result.modifiedCount > 0;
  }

  async resumeBlockedRun(id: string, executionId: string): Promise<boolean> {
    const result = await this.workItemModel.updateOne(
      // A ticket its run parked on dependencies stays parked; the sweep reopens it.
      { _id: id, executionId, status: 'blocked', blockedOn: { $exists: false }, deletedAt: null },
      { $set: { status: 'in_progress' }, $unset: { statusReason: '' } }
    );
    return result.modifiedCount > 0;
  }

  async listForLoop(userId: string, loopId: string, closedLimit: number): Promise<IWorkItem[]> {
    const scope = { userId, loopId, deletedAt: null };
    const [active, closed] = await Promise.all([
      this.workItemModel.find({ ...scope, status: { $ne: 'closed' } }).sort({ createdAt: 1 }),
      this.workItemModel
        .find({ ...scope, status: 'closed' })
        .sort({ closedAt: -1 })
        .limit(closedLimit),
    ]);
    return [...active, ...closed].map(doc => doc.toJSON());
  }

  async softDeleteByLoop(userId: string, loopId: string): Promise<number> {
    const result = await this.workItemModel.updateMany(
      { userId, loopId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async reopenSatisfiedBlocks(limit: number): Promise<IWorkItem[]> {
    const reopened: IWorkItem[] = [];
    // Paged by _id: a still-waiting ticket is not written, so a read capped at `limit` would rescan the same ones.
    let after: string | undefined;
    for (let page = 0; page < REOPEN_SCAN_PAGES && reopened.length < limit; page++) {
      const parked = (
        await this.workItemModel
          .find({
            blockedOn: 'dependencies',
            status: 'blocked',
            loopId: { $exists: true },
            deletedAt: null,
            ...(after && { _id: { $gt: after } }),
          })
          .sort({ _id: 1 })
          .limit(limit)
      ).map(doc => doc.toJSON());
      if (parked.length === 0) break;
      after = parked.at(-1)!.id;
      const depIds = [...new Set(parked.flatMap(item => item.dependencies))].filter(id => mongoose.isValidObjectId(id));
      // Not user-scoped: deps are always the owner's own (assertDependenciesUsable). A foreign one counts as open.
      const deps = await this.workItemModel.find({ _id: { $in: depIds }, deletedAt: null });
      const depById = new Map(deps.map(doc => [String(doc._id), doc]));
      const epicLoopIds = [...new Set(parked.filter(item => item.epic).map(item => item.loopId!))].filter(id =>
        mongoose.isValidObjectId(id)
      );
      const loops = epicLoopIds.length > 0 ? await Loop.find({ _id: { $in: epicLoopIds } }, { stages: 1 }) : [];
      const lastStage = new Map(loops.map(loop => [String(loop._id), loop.stages.at(-1)]));
      for (const item of parked) {
        if (reopened.length >= limit) break;
        const waiting = item.dependencies.some(depId => {
          const dep = depById.get(depId);
          return dep !== undefined && (dep.userId !== item.userId || dep.status !== 'closed');
        });
        if (waiting) continue;
        // An epic's work was its children, so it closes in its loop's last stage (as ticketMovePatch closes one).
        const last = item.epic ? lastStage.get(item.loopId!) : undefined;
        if (item.epic && !last) continue;
        // Matching the deps read above, so a dependency added meanwhile keeps the ticket parked.
        const result = await this.workItemModel.findOneAndUpdate(
          {
            _id: item.id,
            status: 'blocked',
            blockedOn: 'dependencies',
            dependencies: item.dependencies,
            deletedAt: null,
          },
          {
            $set: last ? { status: 'closed', stage: last, closedAt: new Date() } : { status: 'open' },
            $unset: { statusReason: '', blockedOn: '' },
          },
          { new: true }
        );
        if (result) reopened.push(result.toJSON());
      }
    }
    return reopened;
  }

  async countBlockedByLoop(userId: string, loopIds: string[]): Promise<Record<string, number>> {
    const rows = await this.workItemModel.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          userId,
          loopId: { $in: loopIds },
          deletedAt: null,
          status: 'blocked',
          blockedOn: { $exists: false },
        },
      },
      { $group: { _id: '$loopId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(row => [row._id, row.count]));
  }

  async updateForUser(
    id: string,
    userId: string,
    patch: WorkItemPatch,
    expectedStatus?: WorkItemStatus,
    guard?: { statusReason?: string; loopId?: string }
  ): Promise<IWorkItem | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const { set, unset } = splitPatch(patch);
    const result = await this.workItemModel.findOneAndUpdate(
      {
        _id: id,
        userId,
        deletedAt: null,
        ...(expectedStatus && { status: expectedStatus }),
        ...(guard?.statusReason !== undefined && { statusReason: guard.statusReason }),
        ...(guard?.loopId && { loopId: guard.loopId }),
      },
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
    // `null` also matches a missing field, so plain items list as before and loop tickets stay out.
    conditions.loopId = filters.loopId ?? null;
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

  // ponytail: /graph and the cycle check still count closed loop tickets toward MAX_GRAPH_ITEMS; they need
  // them to see every edge. Page the graph if a user's loops ever fill the window.
  private async loadAllForUser(
    userId: string,
    { skipClosedLoopTickets = false } = {}
  ): Promise<{ items: IWorkItem[]; truncated: boolean }> {
    const results = await this.workItemModel
      .find({
        userId,
        deletedAt: null,
        ...(skipClosedLoopTickets && { $or: [{ loopId: null }, { status: { $ne: 'closed' } }] }),
      })
      .sort({ createdAt: 1 })
      .limit(MAX_GRAPH_ITEMS);
    return { items: results.map(doc => doc.toJSON()), truncated: results.length === MAX_GRAPH_ITEMS };
  }
}

/** A `null` in a patch means "clear this field", which only $unset can do. */
function splitPatch(patch: WorkItemPatch): { set: Record<string, unknown>; unset: Record<string, ''> } {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) unset[key] = '';
    else if (value !== undefined) set[key] = value;
  }
  return { set, unset };
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
    loopId: { type: String },
    stage: { type: String },
    executionId: { type: String },
    statusReason: { type: String },
    runCount: { type: Number, default: 0 },
    priority: { type: String, enum: WORK_ITEM_PRIORITIES },
    prioritySetAt: { type: Date },
    prioritySetBy: { type: String, enum: WORK_ITEM_PRIORITY_SETTERS },
    epic: { type: Boolean },
    blockedOn: { type: String, enum: WORK_ITEM_BLOCKERS },
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
WorkItemSchema.index(
  { loopId: 1, deletedAt: 1, status: 1, stage: 1 },
  { partialFilterExpression: { loopId: { $exists: true } } }
);
// The loop notice sweep's global read of blocked loop tickets (apps/workers/src/cron/loopNotices.ts).
WorkItemSchema.index({ status: 1, loopId: 1 }, { partialFilterExpression: { loopId: { $exists: true } } });
// The scheduler's reopen sweep over tickets parked on a testable condition (reopenSatisfiedBlocks).
WorkItemSchema.index({ blockedOn: 1, status: 1 }, { partialFilterExpression: { blockedOn: { $exists: true } } });
// The loop notice sweep's service-level read of p0/p1 loop tickets (listUrgentForLoops).
WorkItemSchema.index({ priority: 1, status: 1 }, { partialFilterExpression: { loopId: { $exists: true } } });
WorkItemSchema.index({ executionId: 1 }, { partialFilterExpression: { executionId: { $exists: true } } });

export const WorkItem: IWorkItemModel =
  (mongoose.models[ModelName] as unknown as IWorkItemModel) ??
  model<IWorkItem, IWorkItemModel>(ModelName, WorkItemSchema);

export const workItemRepository = new WorkItemRepository(WorkItem);

export default WorkItem;

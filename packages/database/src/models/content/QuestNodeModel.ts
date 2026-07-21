import {
  GRAPH_STATE_VALUES,
  IQuestGraph,
  IQuestGraphDocument,
  IQuestGraphRepository,
  IQuestNode,
  IQuestNodeDocument,
  IQuestNodeRepository,
  NODE_KIND_VALUES,
  NODE_STATUS_VALUES,
  NodeExecutionRef,
  NodeStatus,
  QuestGraphCreateInput,
  QuestNodeCreateInput,
  QuestNodeStatusExtra,
  REVIEW_VERDICT_VALUES,
  GraphState,
} from '@bike4mind/common';
import mongoose, { Model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { convertId, convertIds, softDeletePlugin } from '../../utils/mongo';

const QuestGraphSchema = new Schema<IQuestGraph>(
  {
    goal: { type: String, required: true, maxlength: 4000 },
    userId: { type: String, required: true },
    notebookId: { type: String, required: false },
    sessionId: { type: String, required: false },
    rootNodeIds: { type: [String], default: [] },
    state: { type: String, enum: GRAPH_STATE_VALUES, default: 'draft' },
    visibility: { type: String, enum: ['private', 'shared', 'public'], default: 'private' },
    budget: {
      maxDepth: { type: Number, default: 5, min: 0 },
      maxNodes: { type: Number, default: 200, min: 1 },
      maxCredits: { type: Number, required: false, min: 0 },
      maxWallClockMs: { type: Number, required: false, min: 0 },
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const QuestNodeSchema = new Schema<IQuestNode>(
  {
    graphId: { type: String, required: true },
    parentId: { type: String, default: null },
    dependsOn: { type: [String], default: [] },
    order: { type: Number, default: 0 },
    kind: { type: String, enum: NODE_KIND_VALUES, default: 'task' },
    title: { type: String, required: true, maxlength: 500 },
    task: { type: String, required: true, maxlength: 8000 },
    acceptanceCriteria: { type: String, required: false, maxlength: 8000 },
    status: { type: String, enum: NODE_STATUS_VALUES, default: 'pending' },
    score: { type: Number, required: false, default: null },
    reviewVerdict: { type: String, enum: REVIEW_VERDICT_VALUES, required: false },
    enabledTools: { type: [String], default: [] },
    execution: {
      type: new Schema<NodeExecutionRef>(
        {
          agentExecutionId: { type: String, required: false },
          chatMessageId: { type: String, required: false },
          traceRef: { type: String, required: false },
        },
        { _id: false }
      ),
      required: false,
    },
    artifactIds: { type: [String], default: [] },
    depth: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date, required: false },
    completedAt: { type: Date, required: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Performance indexes declared together (see CLAUDE.md MongoDB guidelines).
// deletedAt index is created by softDeletePlugin - do not add a duplicate here.
QuestNodeSchema.index({ graphId: 1, parentId: 1 });
QuestNodeSchema.index({ graphId: 1, status: 1 });
QuestNodeSchema.index({ graphId: 1, order: 1 });
QuestGraphSchema.index({ userId: 1, updatedAt: -1 });

QuestGraphSchema.plugin(softDeletePlugin);
QuestNodeSchema.plugin(softDeletePlugin);

export const QuestGraph = mongoose.models.QuestGraph ?? mongoose.model('QuestGraph', QuestGraphSchema);
export const QuestNode = mongoose.models.QuestNode ?? mongoose.model('QuestNode', QuestNodeSchema);

/**
 * Detect a cycle in a directed dependency graph via DFS coloring. `edges` maps a
 * node id to the ids it depends on; a back-edge into a node still on the
 * recursion stack (gray) is a cycle. Pure - safe to unit test in isolation.
 */
export function hasCycle(edges: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    for (const next of edges.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const id of edges.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}

class QuestGraphRepository extends BaseRepository<IQuestGraphDocument> implements IQuestGraphRepository {
  constructor(private questGraphModel: Model<IQuestGraphDocument>) {
    super(questGraphModel);
  }

  async createGraph(input: QuestGraphCreateInput): Promise<IQuestGraphDocument> {
    // Omitted fields fall through to schema defaults (state, visibility, budget,
    // rootNodeIds). A partial budget still gets per-field subdocument defaults.
    const created = await this.questGraphModel.create({
      goal: input.goal,
      userId: input.userId,
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      ...(input.rootNodeIds ? { rootNodeIds: input.rootNodeIds } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
    });
    return created.toObject();
  }

  async findByUserId(userId: string): Promise<IQuestGraphDocument[]> {
    return this.questGraphModel.find({ userId }).sort({ updatedAt: -1 });
  }

  async updateState(id: string, state: GraphState): Promise<IQuestGraphDocument | null> {
    return this.questGraphModel.findByIdAndUpdate(id, { $set: { state } }, { new: true });
  }

  async addRootNode(graphId: string, nodeId: string): Promise<IQuestGraphDocument | null> {
    return this.questGraphModel.findByIdAndUpdate(graphId, { $addToSet: { rootNodeIds: nodeId } }, { new: true });
  }

  async softDelete(id: string): Promise<void> {
    // deleteOne is overridden by softDeletePlugin to set deletedAt.
    await this.questGraphModel.deleteOne({ _id: convertId(id) });
  }
}

class QuestNodeRepository extends BaseRepository<IQuestNodeDocument> implements IQuestNodeRepository {
  constructor(
    private questNodeModel: Model<IQuestNodeDocument>,
    private questGraphModel: Model<IQuestGraphDocument>
  ) {
    super(questNodeModel);
  }

  async addNode(input: QuestNodeCreateInput): Promise<IQuestNodeDocument> {
    const graph = await this.questGraphModel.findById(input.graphId);
    if (!graph) throw new Error('quest graph not found');

    const nodeCount = await this.questNodeModel.countDocuments({ graphId: input.graphId });
    if (nodeCount >= graph.budget.maxNodes) throw new Error('node budget exceeded');

    // Depth is server-authoritative: derived from the parent, never trusted from
    // the caller.
    let depth = 0;
    if (input.parentId) {
      const parent = await this.questNodeModel.findOne({ _id: convertId(input.parentId), graphId: input.graphId });
      if (!parent) throw new Error('parent node not found');
      depth = parent.depth + 1;
      if (depth > graph.budget.maxDepth) throw new Error('max depth exceeded');
    }

    const dependsOn = input.dependsOn ?? [];
    if (dependsOn.length) {
      const unique = [...new Set(dependsOn)];
      if (!unique.every(id => mongoose.Types.ObjectId.isValid(id))) throw new Error('dependency not found');
      const found = await this.questNodeModel.find(
        { _id: { $in: convertIds(unique) }, graphId: input.graphId },
        { _id: 1 }
      );
      if (found.length !== unique.length) throw new Error('dependency not found');

      // Guard the full edge set including this node's proposed edges. A fresh
      // node has no incoming edges so it cannot close a loop today, but this
      // keeps the invariant literal and correct if edges are ever seeded here.
      const edges = await this.buildEdgeMap(input.graphId);
      edges.set('__pending__', unique);
      if (hasCycle(edges)) throw new Error('dependency cycle detected');
    }

    const created = await this.questNodeModel.create({
      graphId: input.graphId,
      parentId: input.parentId ?? null,
      dependsOn,
      order: input.order ?? 0,
      kind: input.kind ?? 'task',
      title: input.title,
      task: input.task,
      acceptanceCriteria: input.acceptanceCriteria,
      status: input.status ?? 'pending',
      enabledTools: input.enabledTools ?? [],
      artifactIds: input.artifactIds ?? [],
      depth,
    });
    return created.toObject();
  }

  // Adding an edge to an existing node is the operation that can actually close a
  // dependency loop (append-only addNode never can), so the cycle guard lives here too.
  async addDependency(nodeId: string, dependsOnId: string): Promise<IQuestNodeDocument | null> {
    const node = await this.questNodeModel.findById(nodeId);
    if (!node) throw new Error('node not found');

    const dep = await this.questNodeModel.findOne({ _id: convertId(dependsOnId), graphId: node.graphId });
    if (!dep) throw new Error('dependency not found');

    const edges = await this.buildEdgeMap(node.graphId);
    const key = String(node._id);
    edges.set(key, [...(edges.get(key) ?? []), dependsOnId]);
    if (hasCycle(edges)) throw new Error('dependency cycle detected');

    return this.questNodeModel.findByIdAndUpdate(nodeId, { $addToSet: { dependsOn: dependsOnId } }, { new: true });
  }

  async getNodes(graphId: string): Promise<IQuestNodeDocument[]> {
    return this.questNodeModel.find({ graphId }).sort({ order: 1 });
  }

  async getNode(id: string): Promise<IQuestNodeDocument | null> {
    return this.findById(id);
  }

  async updateStatus(
    id: string,
    status: NodeStatus,
    extra?: QuestNodeStatusExtra
  ): Promise<IQuestNodeDocument | null> {
    const set: Record<string, unknown> = { status };
    if (extra?.score !== undefined) set.score = extra.score;
    if (extra?.reviewVerdict !== undefined) set.reviewVerdict = extra.reviewVerdict;
    if (extra?.startedAt !== undefined) set.startedAt = extra.startedAt;
    if (extra?.completedAt !== undefined) set.completedAt = extra.completedAt;
    return this.questNodeModel.findByIdAndUpdate(id, { $set: set }, { new: true });
  }

  async linkArtifacts(id: string, artifactIds: string[]): Promise<IQuestNodeDocument | null> {
    return this.questNodeModel.findByIdAndUpdate(
      id,
      { $addToSet: { artifactIds: { $each: artifactIds } } },
      { new: true }
    );
  }

  async setExecution(id: string, ref: NodeExecutionRef): Promise<IQuestNodeDocument | null> {
    return this.questNodeModel.findByIdAndUpdate(id, { $set: { execution: ref } }, { new: true });
  }

  async computeReadyNodes(graphId: string): Promise<IQuestNodeDocument[]> {
    const nodes = await this.questNodeModel.find({ graphId });
    const statusById = new Map(nodes.map(n => [String(n._id), n.status]));
    return nodes.filter(
      n =>
        (n.status === 'pending' || n.status === 'ready') &&
        n.dependsOn.every(dep => {
          const s = statusById.get(dep);
          return s === 'completed' || s === 'skipped';
        })
    );
  }

  private async buildEdgeMap(graphId: string): Promise<Map<string, string[]>> {
    const nodes = await this.questNodeModel.find({ graphId }, { dependsOn: 1 });
    const edges = new Map<string, string[]>();
    for (const n of nodes) edges.set(String(n._id), [...n.dependsOn]);
    return edges;
  }
}

export const questGraphRepository = new QuestGraphRepository(QuestGraph);
export const questNodeRepository = new QuestNodeRepository(QuestNode, QuestGraph);

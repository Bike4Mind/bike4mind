import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * QuestMaster v5 - a flat, self-referential node graph. A quest is a graph of
 * nodes joined by explicit dependency edges (dependsOn) and a structural parent
 * link (parentId), supporting arbitrary-depth recursion. This is greenfield and
 * independent of the legacy QuestMasterPlan model.
 */

export const NODE_STATUS_VALUES = [
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'needs_review',
  'completed',
  'skipped',
  'failed',
] as const;
export type NodeStatus = (typeof NODE_STATUS_VALUES)[number];

// 'spine' = a legible high-level objective; 'task' = an executable leaf.
export const NODE_KIND_VALUES = ['spine', 'task'] as const;
export type NodeKind = (typeof NODE_KIND_VALUES)[number];

export const REVIEW_VERDICT_VALUES = ['approved', 'needs_changes', 'rejected'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICT_VALUES)[number];

export const GRAPH_STATE_VALUES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
export type GraphState = (typeof GRAPH_STATE_VALUES)[number];

/** Hard ceilings the graph enforces to keep an agentic run bounded. */
export interface QuestGraphBudget {
  maxDepth: number;
  maxNodes: number;
  maxCredits?: number;
  maxWallClockMs?: number;
}

/** Back-references to the runtime artifacts a node's execution produced. */
export interface NodeExecutionRef {
  agentExecutionId?: string;
  chatMessageId?: string;
  traceRef?: string;
}

export interface IQuestGraph {
  id: string;
  goal: string;
  userId: string;
  notebookId?: string;
  sessionId?: string;
  rootNodeIds: string[];
  state: GraphState;
  visibility: 'private' | 'shared' | 'public';
  budget: QuestGraphBudget;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IQuestNode {
  id: string;
  graphId: string;
  parentId?: string | null;
  dependsOn: string[];
  order: number;
  kind: NodeKind;
  title: string;
  task: string;
  acceptanceCriteria?: string;
  status: NodeStatus;
  score?: number | null;
  reviewVerdict?: ReviewVerdict | null;
  enabledTools: string[];
  execution?: NodeExecutionRef;
  artifactIds: string[];
  depth: number;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

// IMongoDocument supplies id/createdAt/updatedAt as required; Omit resolves the
// optional-vs-required clash with the entity interfaces above.
export interface IQuestGraphDocument extends Omit<IQuestGraph, 'createdAt' | 'updatedAt'>, IMongoDocument {}
export interface IQuestNodeDocument extends Omit<IQuestNode, 'createdAt' | 'updatedAt'>, IMongoDocument {}

export interface QuestGraphCreateInput {
  goal: string;
  userId: string;
  notebookId?: string;
  sessionId?: string;
  rootNodeIds?: string[];
  state?: GraphState;
  visibility?: 'private' | 'shared' | 'public';
  budget?: Partial<QuestGraphBudget>;
}

export interface QuestNodeCreateInput {
  graphId: string;
  parentId?: string | null;
  dependsOn?: string[];
  order?: number;
  kind?: NodeKind;
  title: string;
  task: string;
  acceptanceCriteria?: string;
  status?: NodeStatus;
  enabledTools?: string[];
  artifactIds?: string[];
}

export interface QuestNodeStatusExtra {
  score?: number | null;
  reviewVerdict?: ReviewVerdict | null;
  startedAt?: Date;
  completedAt?: Date;
}

export interface IQuestGraphRepository extends IBaseRepository<IQuestGraphDocument> {
  createGraph(input: QuestGraphCreateInput): Promise<IQuestGraphDocument>;
  findByUserId(userId: string): Promise<IQuestGraphDocument[]>;
  updateState(id: string, state: GraphState): Promise<IQuestGraphDocument | null>;
  addRootNode(graphId: string, nodeId: string): Promise<IQuestGraphDocument | null>;
  softDelete(id: string): Promise<void>;
}

export interface IQuestNodeRepository extends IBaseRepository<IQuestNodeDocument> {
  addNode(input: QuestNodeCreateInput): Promise<IQuestNodeDocument>;
  addDependency(nodeId: string, dependsOnId: string): Promise<IQuestNodeDocument | null>;
  getNodes(graphId: string): Promise<IQuestNodeDocument[]>;
  getNode(id: string): Promise<IQuestNodeDocument | null>;
  updateStatus(id: string, status: NodeStatus, extra?: QuestNodeStatusExtra): Promise<IQuestNodeDocument | null>;
  linkArtifacts(id: string, artifactIds: string[]): Promise<IQuestNodeDocument | null>;
  setExecution(id: string, ref: NodeExecutionRef): Promise<IQuestNodeDocument | null>;
  computeReadyNodes(graphId: string): Promise<IQuestNodeDocument[]>;
}

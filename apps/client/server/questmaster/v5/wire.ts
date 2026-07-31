import { z } from 'zod';
import {
  AGENT_EXECUTION_STATUSES,
  GRAPH_STATE_VALUES,
  NODE_KIND_VALUES,
  NODE_STATUS_VALUES,
  REVIEW_VERDICT_VALUES,
} from '@bike4mind/common';
import type { IQuestGraphDocument, IQuestNodeDocument } from '@bike4mind/common';

/**
 * Wire contract for the QuestMaster v5 endpoints, defined once and consumed by
 * `respond()` on the server and by the inferred types on the client. Enums are
 * sourced from the entity constants so the wire can't drift from the model.
 *
 * Dates are `z.date()` because `respond()` validates the pre-serialization
 * object; `res.json` does the ISO conversion afterwards.
 */

export const QuestGraphWireSchema = z.object({
  id: z.string(),
  goal: z.string(),
  sessionId: z.string().optional(),
  notebookId: z.string().optional(),
  state: z.enum(GRAPH_STATE_VALUES),
  visibility: z.enum(['private', 'shared', 'public']),
  rootNodeIds: z.array(z.string()),
  budget: z.object({
    maxDepth: z.number(),
    maxNodes: z.number(),
    maxCredits: z.number().optional(),
    maxWallClockMs: z.number().optional(),
  }),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

/**
 * The run behind a node, flattened onto the node for display. Present only
 * once a node has been dispatched. `answer` is the executor's terminal answer
 * (`execution.result.answer`) and is null until the run reaches it.
 */
export const QuestNodeRunWireSchema = z.object({
  executionId: z.string(),
  status: z.enum(AGENT_EXECUTION_STATUSES),
  answer: z.string().nullable(),
  /** True when `answer` is a prefix. Never truncate silently - the reader has to be able to tell. */
  answerTruncated: z.boolean(),
  totalIterations: z.number().nullable(),
  totalCreditsUsed: z.number().nullable(),
  errorMessage: z.string().nullable(),
});

export const QuestNodeWireSchema = z.object({
  id: z.string(),
  graphId: z.string(),
  parentId: z.string().nullable(),
  dependsOn: z.array(z.string()),
  order: z.number(),
  depth: z.number(),
  kind: z.enum(NODE_KIND_VALUES),
  title: z.string(),
  task: z.string(),
  acceptanceCriteria: z.string().optional(),
  status: z.enum(NODE_STATUS_VALUES),
  score: z.number().nullable().optional(),
  reviewVerdict: z.enum(REVIEW_VERDICT_VALUES).nullable().optional(),
  enabledTools: z.array(z.string()),
  artifactIds: z.array(z.string()),
  isReady: z.boolean(),
  /** Dependencies met AND the status allows a manual dispatch (includes `failed`, which is retryable). */
  isRunnable: z.boolean(),
  run: QuestNodeRunWireSchema.nullable(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
});

export const QuestGraphListResponseSchema = z.object({ graphs: z.array(QuestGraphWireSchema) });
export const QuestGraphCreatedResponseSchema = z.object({ graph: QuestGraphWireSchema });
export const QuestGraphDetailResponseSchema = z.object({
  graph: QuestGraphWireSchema,
  nodes: z.array(QuestNodeWireSchema),
});
export const QuestNodeCreatedResponseSchema = z.object({ node: QuestNodeWireSchema });
export const QuestNodeRunResponseSchema = z.object({
  executionId: z.string(),
  node: QuestNodeWireSchema,
});

export type QuestGraphWire = z.infer<typeof QuestGraphWireSchema>;
export type QuestNodeWire = z.infer<typeof QuestNodeWireSchema>;
export type QuestNodeRunWire = z.infer<typeof QuestNodeRunWireSchema>;

export function toQuestGraphWire(graph: IQuestGraphDocument): QuestGraphWire {
  return {
    id: graph.id,
    goal: graph.goal,
    sessionId: graph.sessionId,
    notebookId: graph.notebookId,
    state: graph.state,
    visibility: graph.visibility,
    rootNodeIds: graph.rootNodeIds,
    budget: {
      maxDepth: graph.budget.maxDepth,
      maxNodes: graph.budget.maxNodes,
      maxCredits: graph.budget.maxCredits,
      maxWallClockMs: graph.budget.maxWallClockMs,
    },
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
}

export function toQuestNodeWire(
  node: IQuestNodeDocument,
  extras: { isReady: boolean; isRunnable: boolean; run: QuestNodeRunWire | null }
): QuestNodeWire {
  return {
    id: node.id,
    graphId: node.graphId,
    parentId: node.parentId ?? null,
    dependsOn: node.dependsOn,
    order: node.order,
    depth: node.depth,
    kind: node.kind,
    title: node.title,
    task: node.task,
    acceptanceCriteria: node.acceptanceCriteria,
    status: node.status,
    score: node.score,
    reviewVerdict: node.reviewVerdict,
    enabledTools: node.enabledTools,
    artifactIds: node.artifactIds,
    isReady: extras.isReady,
    isRunnable: extras.isRunnable,
    run: extras.run,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
  };
}

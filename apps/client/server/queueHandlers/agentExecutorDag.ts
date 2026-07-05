/**
 * DAG-orchestration helpers for the agent executor.
 *
 * Kept in a sibling module so the (already large) `agentExecutor.ts` doesn't
 * grow unbounded. The functions here implement the Phase 4a fan-out flow:
 *
 *   coordinate_task tool
 *      └-> creates N child docs (one per DAG node) via DagDispatcher
 *      └-> dispatches roots to agentContinuationQueue (kind: 'dag_node_dispatch')
 *      └-> sets dagHandoffSignal on the orchestrator's side-channel
 *      └-> parent executor: persistDagSpec + transition to awaiting_dag_children
 *      └-> each dispatched node Lambda runs processSubagentDispatch (DAG nodes are
 *         a flavour of subagent - same flow, with dagNodeId + blockedBy fields)
 *      └-> on node completion, onDagNodeTerminal fires:
 *            - atomically dispatch any siblings now unblocked
 *            - if all siblings terminal, self-dispatch the parent (continuation)
 *      └-> resumeAfterDagChildren in parent: aggregate child results into the
 *         shared `buildPipelineResult` markdown, inject via
 *         `replaceLastToolResultObservation`, transition awaiting_dag_children -> running
 */

import {
  buildPipelineResult,
  findCascadeDoomed,
  findReadyTasks,
  type PipelineTaskResult,
  type PipelineTaskStatus,
} from '@bike4mind/agents';
import type { DagDispatcher, DagNodeHandle } from '@bike4mind/services';
import { agentExecutionRepository, type AgentExecutionStatus, type IDagSpec } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient({});

/**
 * Build a DagDispatcher backed by MongoDB + the agentContinuationQueue.
 *
 * `nodeDefaults` carries the per-execution context every DAG child inherits
 * from its parent - userId, sessionId, questId, model, organizationId. The
 * executor passes these in from the parent execution doc.
 */
export function makeDagDispatcher(args: {
  connectionId: string;
  nodeDefaults: {
    userId: string;
    organizationId?: string;
    sessionId: string;
    questId: string;
    /** Pulled from the parent execution doc - used for audit lineage. */
    spawnedByExecutionId?: string;
  };
  logger: Logger;
}): DagDispatcher {
  const { connectionId, nodeDefaults, logger } = args;

  return {
    async createNode({
      parentExecutionId,
      node,
      thoroughness,
      agentName,
      model,
      maxIterations,
    }): Promise<DagNodeHandle> {
      // Each DAG node is a child AgentExecutionDoc - same shape as a subagent
      // dispatch child, with `dagNodeId` and `blockedBy` populated so the
      // completion handler can resolve the dependency graph.
      //
      // `model` comes from the agent definition's `model` field (resolved by
      // the tool), NOT the parent's session model. processSubagentDispatch
      // uses `child.model` directly when invoking Bedrock - so we must seed
      // it with a model the dispatched Lambda can actually invoke. The
      // parent's session model can be a UI label that doesn't resolve to a
      // provisioned Bedrock inference profile in every stage.
      const child = await agentExecutionRepository.create({
        userId: nodeDefaults.userId,
        organizationId: nodeDefaults.organizationId,
        sessionId: nodeDefaults.sessionId,
        questId: nodeDefaults.questId,
        model,
        query: node.description,
        status: 'pending' as AgentExecutionStatus,
        approvedTools: [],
        deniedTools: [],
        iterationBilling: [],
        totalCreditsUsed: 0,
        lambdaInvocationCount: 1,
        childExecutionIds: [],
        parentExecutionId,
        dagNodeId: node.id,
        blockedBy: node.dependsOn,
        // Snapshot the agent + thoroughness so the dispatched Lambda can
        // reconstruct the agent (same mechanism subagent dispatch uses).
        // `maxIterations` is the resolved per-thoroughness cap from the agent
        // definition - surfaced here so the `subagent_started` WS event the
        // dispatched Lambda emits reports the real cap, not a placeholder.
        subagentConfig: {
          agentName,
          thoroughness,
          maxIterations,
        },
      });
      return { childExecutionId: child.id, dagNodeId: node.id };
    },

    async dispatchNode({ childExecutionId, dagNodeId }) {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: Resource.agentContinuationQueue.url,
          MessageBody: JSON.stringify({
            kind: 'dag_node_dispatch',
            childExecutionId,
            connectionId,
            dagNodeId,
          }),
        })
      );
      logger.info('[DAG] Dispatched node to its own Lambda', { childExecutionId, dagNodeId });
    },
  };
}

/**
 * Hook fired after a DAG child reaches a terminal state (completed/failed/aborted).
 *
 * Two responsibilities:
 *   1. Find sibling nodes whose `blockedBy` is now fully satisfied and
 *      dispatch them via `agentContinuationQueue` (with CAS protection - the
 *      dispatched Lambda CAS-claims `pending -> running` so a duplicate enqueue
 *      from a racing sibling completion is a no-op).
 *   2. If no more siblings remain in a non-terminal state, self-dispatch the
 *      parent via `agentContinuationQueue` (kind: 'continuation') so it can
 *      enter `resumeAfterDagChildren`.
 *
 * The atomic transitions of the parent (`awaiting_dag_children -> continuing`)
 * happen via `claimExecution` inside the parent's resume Lambda, so two
 * simultaneously-completing last-siblings both enqueueing the parent is
 * harmless - only one resume claim succeeds.
 */
export async function onDagNodeTerminal(args: {
  child: {
    id: string;
    parentExecutionId?: string;
    dagNodeId?: string;
    status: AgentExecutionStatus;
  };
  connectionId: string;
  logger: Logger;
}): Promise<void> {
  const { child, connectionId, logger } = args;

  if (!child.dagNodeId || !child.parentExecutionId) return;
  const parentId = child.parentExecutionId;

  const parent = await agentExecutionRepository.findById(parentId);
  if (!parent?.dagSpec) {
    logger.warn('[DAG] terminal child has no parent dagSpec', {
      childId: child.id,
      parentId,
    });
    return;
  }

  const siblings = await agentExecutionRepository.findDagChildrenLean(parentId);

  // Build a node-id -> spec map so we can look up onFailure policy quickly.
  const specByNodeId = new Map(parent.dagSpec.tasks.map(t => [t.id, t]));

  const terminalStatuses: AgentExecutionStatus[] = ['completed', 'failed', 'aborted'];
  const completedIds = new Set<string>();
  const isolatedFailedIds = new Set<string>(); // failed/aborted AND onFailure: 'isolate'
  const cascadeFailedIds = new Set<string>(); // failed/aborted AND onFailure: 'cascade'
  const pendingIds = new Set<string>();
  let anyRunning = false;

  for (const sib of siblings) {
    if (!sib.dagNodeId) continue;
    if (sib.status === 'completed') {
      completedIds.add(sib.dagNodeId);
    } else if (terminalStatuses.includes(sib.status)) {
      // Failed or aborted - bucket by the node's onFailure policy so we can
      // either let dependents proceed (isolate) or sweep them as cascade.
      const spec = specByNodeId.get(sib.dagNodeId);
      if (spec?.onFailure === 'isolate') {
        isolatedFailedIds.add(sib.dagNodeId);
      } else {
        cascadeFailedIds.add(sib.dagNodeId);
      }
    } else if (sib.status === 'pending') {
      pendingIds.add(sib.dagNodeId);
    } else {
      anyRunning = true;
    }
  }

  // Cascade sweep: any pending node whose dep set transitively contains a
  // cascade-failed node is doomed - explicitly mark it terminal so the DAG
  // can finish and the parent resume can fire. Without this, the parent
  // would sit in `awaiting_dag_children` forever waiting on nodes that
  // can never run.
  //
  // Iterate until the doomed set stabilises (handles transitive cascades
  // through chains of dependents).
  if (cascadeFailedIds.size > 0) {
    while (true) {
      const doomed = findCascadeDoomed(parent.dagSpec, pendingIds, cascadeFailedIds);
      if (doomed.length === 0) break;
      for (const doomedId of doomed) {
        const sib = siblings.find(s => s.dagNodeId === doomedId);
        if (!sib) continue;
        const failedDep = specByNodeId.get(doomedId)?.dependsOn.find(d => cascadeFailedIds.has(d));
        await agentExecutionRepository.markFailed(String(sib._id), {
          message: `Blocked by cascade-failed dependency "${failedDep ?? 'upstream'}"`,
        });
        pendingIds.delete(doomedId);
        cascadeFailedIds.add(doomedId);
        logger.info('[DAG] Marked node cascade-failed', {
          parentId,
          dagNodeId: doomedId,
          failedDep,
        });
      }
    }
  }

  // Dispatch any newly-unblocked roots/inner-nodes.
  //
  // We deliberately DO NOT CAS-claim `pending -> running` here. The dispatched
  // Lambda's own CAS inside `processSubagentDispatch` handles duplicate
  // delivery: if two completion handlers race and both dispatch the same
  // newly-unblocked sibling, only the first dispatched Lambda's CAS wins
  // (the second's claim returns false and it exits gracefully). Pre-claiming
  // here would set the doc to `running` BEFORE the dispatched Lambda runs,
  // causing its `pending -> running` CAS to fail and the agent to never start.
  const ready = findReadyTasks(parent.dagSpec, completedIds, pendingIds, isolatedFailedIds);
  for (const readyNodeId of ready) {
    const sib = siblings.find(s => s.dagNodeId === readyNodeId);
    if (!sib) continue;
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: Resource.agentContinuationQueue.url,
        MessageBody: JSON.stringify({
          kind: 'dag_node_dispatch',
          childExecutionId: String(sib._id),
          connectionId,
          dagNodeId: readyNodeId,
        }),
      })
    );
    logger.info('[DAG] Dispatched newly-unblocked node', {
      parentId,
      dagNodeId: readyNodeId,
    });
  }

  // If no more pending and nothing running, the DAG is finished - wake the parent.
  //
  // Note: checkpointDepth is NOT carried here. It lives in the SQS message that triggered the
  // parent Lambda, not in the AgentExecution document, so this hook has no way to read it.
  // The parent resumes at depth 0, effectively getting a fresh depth budget after each DAG wait.
  // This is by design - DAG waits are bounded by child completions, so they can't loop indefinitely
  // on their own. The full fix would persist depth to AgentExecution.
  if (pendingIds.size === 0 && !anyRunning && ready.length === 0) {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: Resource.agentContinuationQueue.url,
        MessageBody: JSON.stringify({
          kind: 'continuation',
          executionId: parentId,
          connectionId,
        }),
      })
    );
    logger.info('[DAG] All children terminal — self-dispatching parent for resume', {
      parentId,
      completed: completedIds.size,
      isolatedFailed: isolatedFailedIds.size,
      cascadeFailed: cascadeFailedIds.size,
    });
  }
}

/**
 * Build the markdown report the parent's `coordinate_task` observation will be
 * replaced with on resume. Reuses the shared `buildPipelineResult` so the
 * synthesized text matches the CLI's coordinator output.
 *
 * `cascade_failed` is detected heuristically: a node whose `blockedBy` includes
 * any non-completed sibling AND whose own status is `pending`. We treat it as
 * skipped (cascade) for v1.
 */
export function buildDagResumeReport(args: {
  dagSpec: IDagSpec;
  children: Array<{
    dagNodeId?: string;
    status: AgentExecutionStatus;
    result?: unknown;
    error?: { message: string; stack?: string };
    blockedBy?: string[];
  }>;
}): { summary: string; success: boolean; failedNodes: string[] } {
  const { dagSpec, children } = args;
  const byNodeId = new Map(children.filter(c => c.dagNodeId).map(c => [c.dagNodeId!, c]));

  const completedIds = new Set(children.filter(c => c.status === 'completed' && c.dagNodeId).map(c => c.dagNodeId!));

  const taskResults: PipelineTaskResult[] = dagSpec.tasks.map(task => {
    const child = byNodeId.get(task.id);
    let status: PipelineTaskStatus = 'pending';
    let result: string | undefined;
    let error: string | undefined;

    if (!child) {
      status = 'pending';
    } else if (child.status === 'completed') {
      status = 'completed';
      result = (child.result as { answer?: string } | undefined)?.answer;
    } else if (child.status === 'failed' || child.status === 'aborted') {
      status = 'failed';
      error = child.error?.message ?? (child.status === 'aborted' ? 'Aborted' : 'Unknown error');
    } else if (child.status === 'pending') {
      // Skipped due to upstream failure if any dep didn't complete.
      const blockedByFailed = task.dependsOn.some(d => !completedIds.has(d));
      if (blockedByFailed) {
        status = 'cascade_failed';
        const failedDep = task.dependsOn.find(d => !completedIds.has(d));
        error = `Blocked by failed dependency "${failedDep}"`;
      } else {
        status = 'pending';
      }
    }

    return {
      id: task.id,
      description: task.description,
      agentType: task.agentType,
      status,
      result,
      error,
    };
  });

  const { summary, success } = buildPipelineResult(taskResults);
  const failedNodes = taskResults.filter(t => t.status === 'failed' || t.status === 'cascade_failed').map(t => t.id);

  return { summary, success, failedNodes };
}

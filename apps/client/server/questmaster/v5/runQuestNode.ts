import { agentExecutionRepository, questNodeRepository, Quest } from '@bike4mind/database';
import type { AgentExecutionStatus, IQuestGraphDocument, IQuestNodeDocument } from '@bike4mind/common';
import { BadRequestError, InternalServerError } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { MAX_CONCURRENT_EXECUTIONS_PER_USER, STALE_ACTIVE_MS } from '@server/utils/executionLimits';

const lambdaClient = new LambdaClient({});

/**
 * A node run is dispatched with no browser attached, so there is no live
 * WebSocket connection to stream to. The executor's `createWsSender` swallows
 * send failures (a stale connection is normal there), so a placeholder id costs
 * one warn log per event and the run proceeds unaffected. Phase 5's graph view
 * will pass the viewer's real connection id when a run is started from the UI.
 */
const HEADLESS_CONNECTION_ID = 'questmaster-v5-headless';

/**
 * The executor's function name off the `lambdaFunctionNames` Linkable, read
 * through a Record view rather than as `Resource.lambdaFunctionNames.agentExecutor`.
 *
 * The generated `sst-env.d.ts` is committed and only learns a new key on the
 * next successful deploy, so a compile-time property access breaks a fresh
 * checkout's build - and CI's, which typechecks against the committed file.
 * Same bridge `modelDiscovery/runNow.ts` uses for exactly this reason.
 *
 * Returns undefined when the link is absent (the web app links the executor's
 * NAME, not the function - the WebSocket handler is the one with the direct
 * link), which the caller reports as a deployment gap rather than a bad request.
 */
function linkedAgentExecutorName(): string | undefined {
  try {
    return (Resource as unknown as { lambdaFunctionNames?: Record<string, string | undefined> }).lambdaFunctionNames
      ?.agentExecutor;
  } catch {
    return undefined;
  }
}

/**
 * Render a node into the single prompt its agent run receives.
 *
 * Acceptance criteria are included even though nothing scores against them yet
 * (Phase 4): telling the agent what "done" means measurably improves the run,
 * and it keeps one authored definition of done rather than the node meaning one
 * thing to the model and another to the scorer later.
 */
export function buildNodeQuery(node: Pick<IQuestNodeDocument, 'title' | 'task' | 'acceptanceCriteria'>): string {
  const parts = [`# ${node.title}`, '', node.task];
  if (node.acceptanceCriteria?.trim()) {
    parts.push('', '## Acceptance criteria', '', node.acceptanceCriteria.trim());
  }
  return parts.join('\n');
}

export interface RunQuestNodeResult {
  executionId: string;
  node: IQuestNodeDocument;
}

/**
 * Dispatch one QuestNode into the existing agent executor.
 *
 * v5 deliberately runs nodes through the same Lambda that powers agent mode
 * rather than a parallel loop, so a node inherits checkpointing, per-iteration
 * billing, permission gating, abort, and Lambda self-dispatch for free. The
 * only v5-specific parts are the prompt (from the node) and the toolset (from
 * `node.enabledTools`).
 *
 * The node is claimed (`in_progress`) FIRST, atomically, so two concurrent
 * dispatches of the same node cannot both bill an execution. Everything after
 * the claim is rolled back to `failed` if it throws - otherwise a node could
 * sit `in_progress` forever with no execution ref, which reconciliation
 * (correctly) refuses to touch.
 */
export async function runQuestNode(args: {
  node: IQuestNodeDocument;
  graph: IQuestGraphDocument;
  userId: string;
  model: string;
  logger: Logger;
}): Promise<RunQuestNodeResult> {
  const { node, graph, userId, model, logger } = args;

  if (!graph.sessionId) {
    // AgentExecution.sessionId is required, and the session is what gives the
    // run its chat-history home. A graph without one cannot dispatch.
    throw new BadRequestError('Quest graph has no session; cannot run nodes');
  }

  // The same per-user concurrency cap the WebSocket dispatcher enforces. A node
  // run creates a top-level AgentExecution exactly like an agent-mode run does,
  // so without this a user with the flag on could hold far more agents in
  // flight through v5 than the cap allows. Sweep first, or executions orphaned
  // by a dead Lambda would count against them (unconditional here rather than
  // memoized as in `agentExecute`: a dispatch is rare and about to cost real
  // credits, so one extra updateMany is noise).
  await agentExecutionRepository.cleanupStaleActive(userId, STALE_ACTIVE_MS);
  const activeCount = await agentExecutionRepository.countActiveByUserId(userId);
  if (activeCount >= MAX_CONCURRENT_EXECUTIONS_PER_USER) {
    throw new BadRequestError(
      `${MAX_CONCURRENT_EXECUTIONS_PER_USER} agents already running. Wait for one to finish before starting another.`
    );
  }

  // Resolved BEFORE the claim: an unlinked executor is a deployment gap, and
  // failing here leaves the node untouched rather than claiming it, rolling it
  // back to `failed`, and making the operator wonder what they did wrong.
  const executorFunctionName = linkedAgentExecutorName();
  if (!executorFunctionName) {
    throw new InternalServerError(
      'Agent executor is not linked to this deployment; a stack deploy is needed before nodes can run'
    );
  }

  const claimed = await questNodeRepository.claimForRun(node.id);
  if (!claimed) {
    // Deliberately does not quote `node.status`: that value was read before the
    // claim, so on a lost race it would name the status the node no longer has.
    throw new BadRequestError('Node is already running, or has completed and cannot be re-run');
  }

  // Everything below reads from `claimed`, not the caller's pre-claim snapshot,
  // so a concurrent edit between the read and the claim can't dispatch a stale
  // prompt or a stale toolset.
  const query = buildNodeQuery(claimed);
  let questId: string | undefined;
  let executionId: string | undefined;

  try {
    // Author the chat-history Quest before the execution so the execution's
    // required `questId` points at a real doc, then link it back by
    // `agentExecutionId` - the key `persistRunAsQuest` patches on at completion.
    // Without this pair the executor's terminal path would create a second,
    // unlinked Quest for the same run. `pending` (not `done`) until the reply
    // lands, matching `agentExecute.handleStart`.
    const quest = await Quest.create({
      sessionId: graph.sessionId,
      type: 'message',
      prompt: query,
      replies: [],
      timestamp: new Date(),
      status: 'pending',
    });
    questId = quest.id;

    const execution = await agentExecutionRepository.create({
      userId,
      sessionId: graph.sessionId,
      questId: quest.id,
      query,
      model,
      status: 'pending' as AgentExecutionStatus,
      connectionId: HEADLESS_CONNECTION_ID,
      approvedTools: [],
      deniedTools: [],
      iterationBilling: [],
      totalCreditsUsed: 0,
      lambdaInvocationCount: 1,
      childExecutionIds: [],
      // A node query is machine-generated text, not a user turn, and a node run
      // is a genuinely top-level execution with no upward lineage - so neither
      // the tri-state opt-out (there is no per-request memory toggle on this
      // dispatch path) nor the lineage guard (`parentExecutionId` /
      // `spawnedByExecutionId`) would otherwise fire. Stamp an explicit `false`
      // so `resolveExecutionMementoGates` short-circuits both the read
      // (`getFirstIterationMementosPreamble`) and write (`publishMementoCompletion`)
      // pipelines: a V5 node never reads a user's beliefs into its prompt nor
      // writes machine-authored ones back.
      enableMementos: false,
    });

    executionId = execution.id;
    await Quest.updateOne({ _id: quest.id }, { $set: { agentExecutionId: executionId } });
    // Written before the invoke so a node can never have a live run the graph
    // cannot see.
    const linked = await questNodeRepository.setExecution(node.id, { agentExecutionId: executionId });
    if (!linked) {
      // The node vanished between the claim and here. Invoking anyway would
      // start a billable run that nothing references - the exact thing writing
      // the ref before the invoke is supposed to prevent. Throw so the catch
      // below closes out the execution and drops the Quest.
      throw new Error(`node ${node.id} disappeared before its execution ref could be written`);
    }

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: executorFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({
            executionId,
            userId,
            sessionId: graph.sessionId,
            questId: quest.id,
            query,
            model,
            connectionId: HEADLESS_CONNECTION_ID,
            // The node's scoped toolset - the per-node tool boundary that makes
            // a v5 node a bounded unit of work rather than a full-toolbelt run.
            // Empty means "no restriction", matching the executor's own
            // `pickEffectiveEnabledTools` semantics.
            ...(claimed.enabledTools.length ? { enabledTools: claimed.enabledTools } : {}),
          })
        ),
      })
    );

    logger.info('[questmaster-v5] node dispatched', { nodeId: node.id, graphId: graph.id, executionId });
    return { executionId, node: linked ?? claimed };
  } catch (err) {
    logger.error('[questmaster-v5] node dispatch failed - rolling the node back to failed', {
      nodeId: node.id,
      questId,
      executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Close out the execution. Left `pending` it would sit in the ACTIVE set,
    // consuming one of the user's concurrency slots until the 20-minute stale
    // sweep reaps it - so a couple of failed dispatches would lock them out of
    // agent mode entirely.
    if (executionId) {
      await agentExecutionRepository
        .markFailed(executionId, { message: 'QuestMaster v5 dispatch failed before the executor started' })
        .catch(markErr => {
          logger.warn('[questmaster-v5] failed to close out the execution after a failed dispatch', {
            executionId,
            error: markErr instanceof Error ? markErr.message : String(markErr),
          });
        });
    }
    // Drop the dispatch-time Quest, or the session keeps a `pending` bubble
    // holding the node's prompt with no reply and no run behind it.
    if (questId) {
      await Quest.deleteOne({ _id: questId }).catch(deleteErr => {
        logger.warn('[questmaster-v5] failed to clean up dispatch Quest after a failed dispatch', {
          questId,
          error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
      });
    }
    await questNodeRepository.updateStatus(node.id, 'failed', { completedAt: new Date() });
    // A throttled Lambda or a failed write is our fault, not the caller's, so
    // this must not come back as a 4xx the client would treat as "bad input".
    const failure = new InternalServerError('Could not start the node run');
    failure.cause = err;
    throw failure;
  }
}

import { questGraphRepository, questNodeRepository } from '@bike4mind/database';
import type { IQuestGraphDocument, IQuestNodeDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { MAX_CONCURRENT_EXECUTIONS_PER_USER } from '@server/utils/executionLimits';
import { runQuestNode } from './runQuestNode';
import { planSchedulerTick, spineNodesToComplete } from './schedulerTick';
import type { NodeRunSummary } from './reconcileQuestNodes';

/**
 * How many of a graph's nodes may run at once.
 *
 * Below the per-user cap on purpose: one rolling graph must not consume every
 * agent slot the user has, or starting a quest would lock them out of chat
 * agent mode entirely.
 */
const MAX_CONCURRENT_PER_GRAPH = Math.max(1, MAX_CONCURRENT_EXECUTIONS_PER_USER - 1);

/**
 * Advance an active graph by one tick: dispatch what is ready, roll up finished
 * phases, and move the graph to completed or paused when it should be.
 *
 * Driven from the graph read rather than a cron. The view already polls while
 * work is in flight, so each poll is a tick and the graph rolls without new
 * infrastructure - which also means it stops rolling when nobody is watching
 * and resumes when they come back. That is a deliberate trade for Phase 2b:
 * a background driver is real autonomy but needs its own Lambda and schedule,
 * and this proves the loop first.
 *
 * Best-effort by contract: a graph read must still return a graph. Every failure
 * here logs and leaves the graph as it was.
 *
 * The per-graph concurrency limit is a GUIDE RAIL, not a lock. In-flight count
 * is read from the graph as it stands, so two overlapping polls can each see the
 * same free slots and dispatch into them. `claimForRun` still guarantees one
 * dispatch per node, and the per-USER cap inside `runQuestNode` is the hard
 * ceiling that actually holds - so the overshoot is bounded and self-correcting
 * on the next tick, not a runaway.
 */
export async function advanceGraph(args: {
  graph: IQuestGraphDocument;
  nodes: IQuestNodeDocument[];
  runs: Map<string, NodeRunSummary>;
  model: string;
  logger: Logger;
}): Promise<{ dispatched: string[]; stateChangedTo: string | null }> {
  const { graph, nodes, runs, model, logger } = args;
  const none = { dispatched: [] as string[], stateChangedTo: null };

  if (graph.state !== 'active') return none;

  try {
    // Roll up finished phases first, so a spine that just finished reads as done
    // on this very response rather than one tick later.
    const spineIds = spineNodesToComplete(nodes);
    for (const id of spineIds) {
      await questNodeRepository.updateStatus(id, 'completed', { completedAt: new Date() });
    }

    const creditsUsed = [...runs.values()].reduce((sum, r) => sum + (r.totalCreditsUsed ?? 0), 0);
    // Measured from the earliest dispatch, which is when the graph actually
    // started spending, not when its row was created.
    const startedAts = nodes.map(n => n.startedAt?.getTime()).filter((t): t is number => typeof t === 'number');
    const elapsedMs = startedAts.length ? Date.now() - Math.min(...startedAts) : null;

    const decision = planSchedulerTick({
      state: graph.state,
      // Re-read the spine statuses we just wrote so the tick sees them.
      nodes: nodes.map(n => ({
        id: n.id,
        status: spineIds.includes(n.id) ? 'completed' : n.status,
        dependsOn: n.dependsOn,
        kind: n.kind,
      })),
      budget: graph.budget,
      creditsUsed,
      elapsedMs,
      maxConcurrent: MAX_CONCURRENT_PER_GRAPH,
    });

    if (decision.action === 'complete') {
      await questGraphRepository.updateState(graph.id, 'completed');
      logger.info('[questmaster-v5] graph completed', { graphId: graph.id });
      return { dispatched: [], stateChangedTo: 'completed' };
    }

    if (decision.action === 'pause') {
      await questGraphRepository.updateState(graph.id, 'paused');
      logger.info('[questmaster-v5] graph paused', { graphId: graph.id, reason: decision.reason });
      return { dispatched: [], stateChangedTo: 'paused' };
    }

    if (decision.action !== 'dispatch') return none;

    const dispatched: string[] = [];
    for (const nodeId of decision.nodeIds) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) continue;
      try {
        await runQuestNode({ node, graph, userId: graph.userId, model, logger });
        dispatched.push(nodeId);
      } catch (err) {
        // The per-user concurrency cap and a lost claim both land here and are
        // both normal: another tick, or another graph, got there first. Stop
        // dispatching this tick rather than hammering a full queue.
        logger.info('[questmaster-v5] scheduler could not dispatch a node this tick', {
          graphId: graph.id,
          nodeId,
          reason: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    if (dispatched.length) logger.info('[questmaster-v5] scheduler dispatched', { graphId: graph.id, dispatched });
    return { dispatched, stateChangedTo: null };
  } catch (err) {
    logger.warn('[questmaster-v5] scheduler tick failed - graph left unchanged', {
      graphId: graph.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return none;
  }
}

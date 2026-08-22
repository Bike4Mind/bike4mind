import {
  agentExecutionRepository,
  cacheRepository,
  questGraphRepository,
  questNodeRepository,
} from '@bike4mind/database';
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
 * The same 20/min ceiling `quest-nodes/[id]/run.ts` puts on a manual run,
 * applied to scheduler dispatch.
 *
 * The tick hangs off a GET, which carries no `rateLimit` middleware and, being a
 * GET, no CSRF token - so without this the billable dispatch was reachable at
 * whatever rate the caller chose to poll. Limiting the READ is the wrong lever
 * (a 3-second poll is legitimate and expected); limiting the dispatch is the
 * thing that costs money, so the budget lives here and is keyed per user, which
 * is who gets billed.
 */
const DISPATCH_LIMIT_PER_WINDOW = 20;
const DISPATCH_WINDOW_MS = 60_000;

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
    //
    // Guarded PER SPINE. Phase roll-up is presentation, not scheduling: one
    // failed write must not abort the tick and take the dispatch - which has
    // nothing to do with it - down as well. Same treatment `reconcileQuestNodes`
    // gives its per-node writes.
    const rolledUp: string[] = [];
    for (const id of spineNodesToComplete(nodes)) {
      try {
        await questNodeRepository.updateStatus(id, 'completed', { completedAt: new Date() });
        rolledUp.push(id);
      } catch (err) {
        logger.warn('[questmaster-v5] could not roll up a finished phase - continuing the tick', {
          graphId: graph.id,
          nodeId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const creditsUsed = [...runs.values()].reduce((sum, r) => sum + (r.totalCreditsUsed ?? 0), 0);
    const elapsedMs = rollingElapsedMs(graph, nodes);

    const decision = planSchedulerTick({
      state: graph.state,
      // Re-read the spine statuses we just wrote so the tick sees them.
      nodes: nodes.map(n => ({
        id: n.id,
        // Only the roll-ups that actually landed, so the decision never reasons
        // off a status the database does not hold.
        status: rolledUp.includes(n.id) ? 'completed' : n.status,
        dependsOn: n.dependsOn,
        kind: n.kind,
      })),
      budget: graph.budget,
      creditsUsed,
      elapsedMs,
      maxConcurrent: MAX_CONCURRENT_PER_GRAPH,
    });

    if (decision.action === 'complete') {
      // A completion containing failures is still a completion, but saying so is
      // the difference between a green chip and an honest one.
      const reason = decision.failedCount > 0 ? `finished with ${decision.failedCount} failed task(s)` : null;
      await questGraphRepository.updateState(graph.id, 'completed', { reason });
      logger.info('[questmaster-v5] graph completed', { graphId: graph.id, failedCount: decision.failedCount });
      return { dispatched: [], stateChangedTo: 'completed' };
    }

    if (decision.action === 'pause') {
      // Persisted, not just logged: a stall and a budget stop used to render the
      // same bare `paused` chip as a quest the user paused by hand, which
      // undercut the whole reason for pausing instead of idling.
      await questGraphRepository.updateState(graph.id, 'paused', { reason: decision.reason });
      logger.info('[questmaster-v5] graph paused', { graphId: graph.id, reason: decision.reason });
      return { dispatched: [], stateChangedTo: 'paused' };
    }

    if (decision.action !== 'dispatch') return none;

    // Checked here, before runQuestNode, because `runQuestNode` only discovers
    // it after an unconditional `cleanupStaleActive` updateMany. That sweep is
    // justified for a rare manual dispatch "about to cost real credits"; paid on
    // every 3-second poll by a user who is at their cap from elsewhere, it is
    // ~20 pointless collection sweeps a minute for as long as they watch.
    const activeCount = await agentExecutionRepository.countActiveByUserId(graph.userId);
    if (activeCount >= MAX_CONCURRENT_EXECUTIONS_PER_USER) {
      logger.debug('[questmaster-v5] scheduler idle - user is at their execution cap', {
        graphId: graph.id,
        activeCount,
      });
      return none;
    }

    const dispatched: string[] = [];
    for (const nodeId of decision.nodeIds) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) continue;
      // Counted per NODE, not per tick: one dispatch is one billable agent
      // execution, which is exactly what the manual route's 20/min bounds.
      if (!(await dispatchBudgetAvailable(graph.userId))) {
        logger.info('[questmaster-v5] scheduler stopped dispatching - rate limit reached', {
          graphId: graph.id,
          dispatched: dispatched.length,
        });
        break;
      }
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

/**
 * How long the CURRENT rolling stretch has been spending, or null if it has not
 * spent anything yet.
 *
 * Measured from the earliest dispatch at or after `rollingStartedAt` - the
 * moment someone pressed Run quest - not from the earliest `startedAt` in the
 * graph's whole history. That older reading made a quest with a manual run from
 * days ago instantly over budget, and made a wall-clock pause unrecoverable:
 * elapsed only ever grew, so every resume re-paused immediately with no way back
 * short of editing the budget.
 *
 * A graph with no `rollingStartedAt` (activated before this field existed) falls
 * back to the old reading rather than reporting no elapsed time at all, so an
 * existing budget keeps being enforced.
 */
function rollingElapsedMs(graph: IQuestGraphDocument, nodes: IQuestNodeDocument[]): number | null {
  const rollingSince = graph.rollingStartedAt?.getTime() ?? null;
  const startedAts = nodes
    .map(n => n.startedAt?.getTime())
    .filter((t): t is number => typeof t === 'number')
    .filter(t => rollingSince === null || t >= rollingSince);

  if (!startedAts.length) return null;
  return Date.now() - Math.min(...startedAts);
}

/**
 * Whether this user may spend another scheduler dispatch in the current window.
 *
 * Uses the same atomic conditional-increment the `rateLimit` middleware uses, so
 * concurrent polls cannot undercount. A cache failure returns true: the read
 * path must keep working, and the per-user execution cap is still the hard
 * ceiling behind this.
 */
async function dispatchBudgetAvailable(userId: string): Promise<boolean> {
  try {
    const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `questmaster-v5-dispatch:${userId}`,
      DISPATCH_LIMIT_PER_WINDOW,
      DISPATCH_WINDOW_MS
    );
    return success;
  } catch {
    return true;
  }
}

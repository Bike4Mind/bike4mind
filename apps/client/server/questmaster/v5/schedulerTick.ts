import { isNodeReady } from '@bike4mind/database';
import type { GraphState, NodeStatus, QuestGraphBudget } from '@bike4mind/common';

/**
 * The scheduler's decision for one tick. Pure: it reads a graph's current shape
 * and says what should happen next, without touching anything.
 *
 * Separated from the execution so the interesting part - when does a graph stall,
 * when has it overspent, when is it genuinely finished - is testable without a
 * database, a model, or a Lambda.
 */
export type TickDecision =
  | { action: 'idle'; reason: string }
  | { action: 'dispatch'; nodeIds: string[] }
  /**
   * `failedCount` is on the decision, not left for the view to re-derive: a
   * graph whose every task failed is finished, but reporting it as a plain
   * `completed` chip is a wrong signal rather than a neutral one.
   */
  | { action: 'complete'; failedCount: number }
  | { action: 'pause'; reason: string };

/** The slice of a node the scheduler reasons about. */
export interface SchedulableNode {
  id: string;
  status: NodeStatus;
  dependsOn: string[];
  kind: 'spine' | 'task';
}

const TERMINAL: NodeStatus[] = ['completed', 'skipped', 'failed'];
const isTerminal = (s: NodeStatus) => TERMINAL.includes(s);

/**
 * Decide what a graph should do next.
 *
 * Only `task` nodes are ever dispatched. A `spine` node is a legible phase
 * heading, not work - it has no prompt worth running, and running one would
 * bill a model to restate an objective.
 *
 * Order matters: budget is checked before dispatch, so an overspent graph
 * cannot sneak one more billable run out on its way to being paused.
 */
export function planSchedulerTick(args: {
  state: GraphState;
  nodes: readonly SchedulableNode[];
  budget: Pick<QuestGraphBudget, 'maxCredits' | 'maxWallClockMs'>;
  creditsUsed: number;
  elapsedMs: number | null;
  maxConcurrent: number;
}): TickDecision {
  const { state, nodes, budget, creditsUsed, elapsedMs, maxConcurrent } = args;

  if (state !== 'active') return { action: 'idle', reason: `graph is ${state}` };

  if (budget.maxCredits !== undefined && creditsUsed >= budget.maxCredits) {
    return { action: 'pause', reason: `credit budget spent (${Math.round(creditsUsed)}/${budget.maxCredits})` };
  }
  if (budget.maxWallClockMs !== undefined && elapsedMs !== null && elapsedMs >= budget.maxWallClockMs) {
    return { action: 'pause', reason: 'wall-clock budget elapsed' };
  }

  const tasks = nodes.filter(n => n.kind === 'task');
  const inFlight = tasks.filter(n => n.status === 'in_progress');

  // Readiness uses the same rule the repository query does, so the scheduler and
  // `computeReadyNodes` can never disagree about what is runnable.
  const statusById = new Map<string, NodeStatus>(nodes.map(n => [n.id, n.status]));
  const ready = tasks.filter(n => isNodeReady(n, statusById));

  const slots = maxConcurrent - inFlight.length;
  if (ready.length > 0 && slots > 0) {
    return { action: 'dispatch', nodeIds: ready.slice(0, slots).map(n => n.id) };
  }

  if (inFlight.length > 0) {
    return { action: 'idle', reason: ready.length > 0 ? 'at concurrency limit' : 'waiting on running nodes' };
  }

  // Nothing running and nothing ready. Either the graph is done, or it is stuck.
  const unfinished = tasks.filter(n => !isTerminal(n.status));
  if (unfinished.length === 0) {
    return { action: 'complete', failedCount: tasks.filter(n => n.status === 'failed').length };
  }

  // Unfinished work that can never become ready. Pausing beats idling forever,
  // because a paused graph says so and an idle one just looks slow.
  //
  // The reason names the actual blocker. "Check for a failed dependency" was
  // the only explanation offered, which sent the reader hunting for a failure
  // that may never have happened - a task waiting on a childless spine, or on a
  // node from another graph, blocks the same way with nothing failed anywhere.
  return { action: 'pause', reason: stallReason(unfinished, statusById) };
}

/** Why the unfinished work can no longer become ready, in the user's terms. */
function stallReason(unfinished: readonly SchedulableNode[], statusById: Map<string, NodeStatus>): string {
  const blockers = new Set<string>();
  for (const node of unfinished) {
    for (const dep of node.dependsOn) {
      const status = statusById.get(dep);
      if (status === undefined) blockers.add('a dependency that no longer exists');
      else if (status === 'failed') blockers.add('a failed dependency');
      else if (!isTerminal(status)) blockers.add('a dependency that never finished');
    }
  }

  const count = `${unfinished.length} node(s) can no longer become ready`;
  if (blockers.size === 0) return `${count} - nothing is left to unblock them`;
  return `${count} - waiting on ${[...blockers].join(', ')}`;
}

/**
 * Spine nodes whose work is finished, so a phase heading reflects its phase.
 *
 * Spines are never dispatched, so nothing else would ever move them off
 * `pending` and the graph would read as permanently unfinished.
 *
 * A CHILDLESS spine counts as finished. It has no work to wait for, and leaving
 * it `pending` made it a permanent blocker: `isNodeReady` requires every
 * dependency to be `completed` or `skipped`, so any task listing a childless
 * spine in `dependsOn` could never become ready, and the graph paused citing a
 * dependency failure that had not happened. The shape is reachable by hand today
 * - `nodes.ts` validates that a dependency exists, not what kind it is.
 */
export function spineNodesToComplete(nodes: readonly (SchedulableNode & { parentId?: string | null })[]): string[] {
  const childrenBySpine = new Map<string, SchedulableNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'task' || !node.parentId) continue;
    const list = childrenBySpine.get(node.parentId) ?? [];
    list.push(node);
    childrenBySpine.set(node.parentId, list);
  }

  return nodes
    .filter(n => n.kind === 'spine' && !isTerminal(n.status))
    .filter(spine => {
      const children = childrenBySpine.get(spine.id) ?? [];
      return children.every(c => isTerminal(c.status));
    })
    .map(spine => spine.id);
}

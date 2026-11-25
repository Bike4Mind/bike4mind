import type { ChildOutcome } from './agentOutcome';
import type { ChatSessionStatus, ChatSessionSummary, SessionBackgroundJobs } from './chat';
import type { WorkerTask } from './orchestration';

export const MISSING_TASK_RESULT_REASON = 'The attempt stopped without a structured result.';

export function isUpdateOnlyTask(state: WorkerTask['state']): boolean {
  return (
    (state.status === 'completed' && state.accepted === true) ||
    (state.status === 'blocked' && !state.decision && state.reason === MISSING_TASK_RESULT_REASON)
  );
}

/*
 * An agent's state as the stage, the menu-bar summary and the mini Tavern show it. Shared so the
 * renderer's roster and main (main/watch) cannot disagree on what "done" or "needs you" means.
 */

/**
 * 'waiting': the turn ended but background commands it started are still running, and their exit
 * wakes it. 'paused': the agent loop ran out of its turn budget mid-task, so it can be continued.
 */
export type AgentState = 'needs-you' | 'working' | 'waiting' | 'done' | 'failed' | 'paused' | 'stopped' | 'idle';

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
  stopped: 'Stopped',
  idle: 'Idle',
};

/** Roster order: what wants attention first, finished work last. */
export const AGENT_STATE_PRIORITY: readonly AgentState[] = [
  'needs-you',
  'working',
  'waiting',
  'failed',
  'paused',
  'stopped',
  'idle',
  'done',
];

export type AgentStateCounts = Record<AgentState, number> & { total: number };

/**
 * The one count every surface shows (Tavern, stage strip, menu bar, mini Tavern). `parentsNeedingYou`
 * adds the orchestrating sessions waiting on the user, as the dock badge counts them; `total` stays
 * the agents. Done is finished work only: idle and stopped keep their own buckets.
 */
export function countAgentStates(states: readonly AgentState[], parentsNeedingYou = 0): AgentStateCounts {
  const counts: AgentStateCounts = {
    total: states.length,
    'needs-you': parentsNeedingYou,
    working: 0,
    waiting: 0,
    done: 0,
    failed: 0,
    paused: 0,
    stopped: 0,
    idle: 0,
  };
  for (const state of states) counts[state] += 1;
  return counts;
}

/**
 * "4 agents: 1 needs you, 2 working, 1 done", most urgent first, from countAgentStates. With no agents
 * it says "No agents yet" whatever `parentsNeedingYou` is: a waiting parent has nobody to count beside.
 */
export function describeAgentStates(states: readonly AgentState[], parentsNeedingYou = 0): string {
  const counts = countAgentStates(states, parentsNeedingYou);
  if (counts.total === 0) return 'No agents yet';
  const parts = AGENT_STATE_PRIORITY.filter(state => counts[state] > 0).map(
    state =>
      `${counts[state]} ${state === 'needs-you' && counts[state] > 1 ? 'need you' : AGENT_STATE_LABEL[state].toLowerCase()}`
  );
  return `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}: ${parts.join(', ')}`;
}

// Must stay in step with outcomeLabel (main/chat/agentWake.ts), which tells the parent the same thing:
// a cut-short reply is still done, and a step or context limit stopped it early rather than failing it.
const OUTCOME_STATE: Record<ChildOutcome, AgentState> = {
  finished: 'done',
  'max-tokens': 'done',
  failed: 'failed',
  'turn-budget': 'paused',
  'context-limit': 'stopped',
  aborted: 'stopped',
  'no-reply': 'idle',
};

/** Attention comes only from SessionActivity, just like the sidebar badge, including task decisions. */
export function deriveTaskAgentState(
  session: Pick<ChatSessionSummary, 'workerTask' | 'lastOutcome'>,
  status: ChatSessionStatus | undefined,
  background?: SessionBackgroundJobs
): AgentState {
  const runtimeState = deriveAgentState(status, session.lastOutcome, background);
  const task = session.workerTask?.state;
  if (runtimeState === 'working' || runtimeState === 'needs-you' || !task) return runtimeState;
  // A pending decision arrives as 'needs-action' above, so running jobs only ever outrank a settled task.
  if (runtimeState === 'waiting') return 'waiting';
  if (task.status === 'completed') return 'done';
  if (task.status === 'canceled') return 'stopped';
  return runtimeState;
}

/**
 * The live status wins; then running background jobs the agent will be woken by; a stored outcome
 * only speaks for a session that is neither running, waiting on the user, nor waiting on its jobs.
 */
export function deriveAgentState(
  status: ChatSessionStatus | undefined,
  outcome: ChildOutcome | undefined,
  background?: SessionBackgroundJobs
): AgentState {
  if (status === 'needs-action') return 'needs-you';
  if (status === 'processing') return 'working';
  if (background && background.running > 0) return 'waiting';
  return outcome ? OUTCOME_STATE[outcome] : 'idle';
}

/** The states Stop reaches: a reply running, or waiting on the user. Shared by the peek drawer and the view contract. */
export const isStoppableState = (state: AgentState): boolean => state === 'working' || state === 'needs-you';

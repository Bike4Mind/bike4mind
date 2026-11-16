import type { ChildOutcome } from './agentOutcome';
import type { ChatSessionStatus, ChatSessionSummary } from './chat';

/*
 * An agent's state as the stage, the menu-bar summary and the mini Tavern show it. Shared so the
 * renderer's roster and main (main/watch) cannot disagree on what "done" or "needs you" means.
 */

export type AgentState = 'needs-you' | 'working' | 'done' | 'failed' | 'stopped' | 'idle';

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

/** Roster order: what wants attention first, finished work last. */
export const AGENT_STATE_PRIORITY: readonly AgentState[] = [
  'needs-you',
  'working',
  'failed',
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
    done: 0,
    failed: 0,
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
  'turn-budget': 'stopped',
  'context-limit': 'stopped',
  aborted: 'stopped',
  'no-reply': 'idle',
};

/**
 * "Needs you" is a live approval or question, or a worker task waiting on the user's decision in its
 * Task panel (blocked, escalated, paused, or finished and not yet accepted). needsYouCount (the dock
 * badge) and the watch model (menu bar) count sessions by this same rule.
 */
export function deriveTaskAgentState(
  session: Pick<ChatSessionSummary, 'workerTask' | 'lastOutcome'>,
  status: ChatSessionStatus | undefined
): AgentState {
  const runtimeState = deriveAgentState(status, session.lastOutcome);
  const task = session.workerTask?.state;
  if (runtimeState === 'working' || runtimeState === 'needs-you' || !task) return runtimeState;
  // Queued or running with no live status (a pre-reply gap, a model switch, a restart) waits on nothing.
  if (task.status === 'queued' || task.status === 'running') return runtimeState;
  if (task.status === 'completed' && task.accepted) return 'done';
  return task.status === 'canceled' ? 'stopped' : 'needs-you';
}

/** The live status wins; a stored outcome only speaks for a session that is neither running nor waiting. */
export function deriveAgentState(status: ChatSessionStatus | undefined, outcome: ChildOutcome | undefined): AgentState {
  if (status === 'needs-action') return 'needs-you';
  if (status === 'processing') return 'working';
  return outcome ? OUTCOME_STATE[outcome] : 'idle';
}

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

/** "4 agents: 1 needs you, 2 working, 1 done", most urgent first; idle and stopped count as done. */
export function describeAgentStates(states: readonly AgentState[]): string {
  if (states.length === 0) return 'No agents yet';
  const counts = new Map<AgentState, number>();
  for (const state of states) {
    const bucket = state === 'idle' || state === 'stopped' ? 'done' : state;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const parts = AGENT_STATE_PRIORITY.filter(state => counts.has(state)).map(
    state => `${counts.get(state)} ${AGENT_STATE_LABEL[state].toLowerCase()}`
  );
  return `${states.length} ${states.length === 1 ? 'agent' : 'agents'}: ${parts.join(', ')}`;
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

export function deriveTaskAgentState(
  session: Pick<ChatSessionSummary, 'workerTask' | 'lastOutcome'>,
  status: ChatSessionStatus | undefined
): AgentState {
  const runtimeState = deriveAgentState(status, session.lastOutcome);
  const task = session.workerTask?.state;
  if (runtimeState === 'working' || runtimeState === 'needs-you' || !task) return runtimeState;
  if (task.status === 'completed' && task.accepted) return 'done';
  return task.status === 'canceled' ? 'stopped' : 'needs-you';
}

/** The live status wins; a stored outcome only speaks for a session that is neither running nor waiting. */
export function deriveAgentState(status: ChatSessionStatus | undefined, outcome: ChildOutcome | undefined): AgentState {
  if (status === 'needs-action') return 'needs-you';
  if (status === 'processing') return 'working';
  return outcome ? OUTCOME_STATE[outcome] : 'idle';
}

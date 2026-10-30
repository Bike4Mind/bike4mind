import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import type { AgentActivity } from './activity';

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

export interface AgentView {
  id: string;
  title: string;
  parentId: string;
  /** 1 for a direct child of the root. */
  depth: number;
  seedPrompt: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  state: AgentState;
  outcome?: ChildOutcome;
  activity?: AgentActivity;
  lastSnippet?: string;
  usdCost?: number;
  credits?: number;
  pr?: PrSummary;
  branch?: string;
}

const OUTCOME_STATE: Record<ChildOutcome, AgentState> = {
  finished: 'done',
  'max-tokens': 'failed',
  failed: 'failed',
  'turn-budget': 'failed',
  'context-limit': 'failed',
  aborted: 'stopped',
  'no-reply': 'idle',
};

/** The live status wins; a stored outcome only speaks for a session that is neither running nor waiting. */
export function deriveAgentState(status: ChatSessionStatus | undefined, outcome: ChildOutcome | undefined): AgentState {
  if (status === 'needs-action') return 'needs-you';
  if (status === 'processing') return 'working';
  return outcome ? OUTCOME_STATE[outcome] : 'idle';
}

/**
 * Distance from `rootId` up the parent chain, or null if the chain ends elsewhere, loops, or passes
 * through an archived session below the root (archiving an agent shelves its whole subtree).
 */
function depthBelow(
  session: ChatSessionSummary,
  rootId: string,
  byId: ReadonlyMap<string, ChatSessionSummary>
): number | null {
  const visited = new Set<string>([session.id]);
  let depth = 0;
  let current: ChatSessionSummary | undefined = session;
  while (current?.origin) {
    depth += 1;
    const parentId: string = current.origin.parentSessionId;
    if (parentId === rootId) return depth;
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    current = byId.get(parentId);
    if (current?.archived) return null;
  }
  return null;
}

type SpawnedSession = ChatSessionSummary & Required<Pick<ChatSessionSummary, 'origin'>>;

const isSpawned = (session: ChatSessionSummary): session is SpawnedSession => session.origin !== undefined;

/** Every live session below `rootId`, with its depth. Shared by buildRoster and descendantIds. */
function descendantsOf(
  sessions: readonly ChatSessionSummary[],
  rootId: string
): Array<{ session: SpawnedSession; depth: number }> {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const found: Array<{ session: SpawnedSession; depth: number }> = [];
  for (const session of sessions) {
    if (session.archived || !isSpawned(session) || session.id === rootId) continue;
    const depth = depthBelow(session, rootId, byId);
    if (depth !== null) found.push({ session, depth });
  }
  return found;
}

/** The ids buildRoster would list for `rootId`; cheap enough to compute on every render. */
export function descendantIds(sessions: readonly ChatSessionSummary[], rootId: string | null): Set<string> {
  if (rootId === null) return new Set();
  return new Set(descendantsOf(sessions, rootId).map(({ session }) => session.id));
}

/** Each agent's state from statuses alone: what the header chip needs, with no activity subscription. */
export function agentStates(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  rootId: string | null
): AgentState[] {
  if (rootId === null) return [];
  return descendantsOf(sessions, rootId).map(({ session }) =>
    deriveAgentState(statuses.get(session.id), session.lastOutcome)
  );
}

export function buildRoster(input: {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  activity: ReadonlyMap<string, AgentActivity>;
  prSummaries: ReadonlyMap<string, PrSummary>;
  rootId: string;
}): AgentView[] {
  const { sessions, statuses, activity, prSummaries, rootId } = input;
  const views: AgentView[] = [];

  for (const { session, depth } of descendantsOf(sessions, rootId)) {
    const state = deriveAgentState(statuses.get(session.id), session.lastOutcome);
    views.push({
      id: session.id,
      title: session.title.trim() || 'Untitled agent',
      parentId: session.origin.parentSessionId,
      depth,
      seedPrompt: session.origin.seedPrompt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      state,
      outcome: session.lastOutcome,
      activity: state === 'working' ? activity.get(session.id) : undefined,
      lastSnippet: session.lastSnippet,
      usdCost: session.totalUsdCost,
      credits: session.totalCredits,
      pr: prSummaries.get(session.id),
      branch: session.project?.workspaceBranch ?? session.project?.branch,
    });
  }

  return views.sort(
    (a, b) =>
      AGENT_STATE_PRIORITY.indexOf(a.state) - AGENT_STATE_PRIORITY.indexOf(b.state) ||
      b.createdAt.localeCompare(a.createdAt)
  );
}

export interface RosterSummary {
  total: number;
  counts: Record<AgentState, number>;
  usdCost: number;
  credits: number;
  /** Some agent reported a dollar cost, so the total is shown in dollars rather than credits. */
  hasUsd: boolean;
  /** Some agent lacks the shown currency (credit-only beside dollars, or no cost), so the total is a floor. */
  costPartial: boolean;
}

export function summarizeRoster(agents: readonly AgentView[]): RosterSummary {
  const counts: Record<AgentState, number> = { 'needs-you': 0, working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  let usdCost = 0;
  let credits = 0;
  for (const agent of agents) {
    counts[agent.state] += 1;
    usdCost += agent.usdCost ?? 0;
    credits += agent.credits ?? 0;
  }
  const hasUsd = agents.some(agent => agent.usdCost !== undefined);
  const costPartial = agents.some(agent => (hasUsd ? agent.usdCost : agent.credits) === undefined);
  return { total: agents.length, counts, usdCost, credits, hasUsd, costPartial };
}

export function formatAgentCost(usdCost?: number, credits?: number): string {
  if (usdCost !== undefined) return `$${usdCost.toFixed(2)}`;
  if (credits !== undefined) return `${credits} cr`;
  return '-';
}

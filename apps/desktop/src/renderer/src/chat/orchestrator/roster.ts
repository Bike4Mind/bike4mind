import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { formatCredits } from '../statusLine';
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
  /** Working, but still being prepared (worktree, held first turn); stays 'working' for every count. */
  preparing?: boolean;
  outcome?: ChildOutcome;
  activity?: AgentActivity;
  lastSnippet?: string;
  usdCost?: number;
  credits?: number;
  pr?: PrSummary;
  branch?: string;
}

/** The orchestrating (root) session itself, as the stage sees it: no roster entry, just what it is doing. */
export interface ParentView {
  status?: ChatSessionStatus;
  activity?: AgentActivity;
}

export const isParentBusy = (parent: ParentView) => parent.status === 'processing' || parent.status === 'needs-action';

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

/**
 * Who started an agent below the first level: the agent that spawned it, by `nameOf` (a title or a
 * persona). Undefined for a direct child of the root, or when the spawner is not on the roster.
 */
export function spawnerName(
  agent: Pick<AgentView, 'depth' | 'parentId'>,
  agents: readonly AgentView[],
  nameOf: (spawner: AgentView) => string = spawner => spawner.title
): string | undefined {
  if (agent.depth <= 1) return undefined;
  const spawner = agents.find(candidate => candidate.id === agent.parentId);
  return spawner && nameOf(spawner);
}

export function buildRoster(input: {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  preparing?: ReadonlySet<string>;
  activity: ReadonlyMap<string, AgentActivity>;
  prSummaries: ReadonlyMap<string, PrSummary>;
  rootId: string;
}): AgentView[] {
  const { sessions, statuses, preparing, activity, prSummaries, rootId } = input;
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
      ...(state === 'working' && preparing?.has(session.id) && { preparing: true }),
      outcome: session.lastOutcome,
      activity: state === 'working' || state === 'needs-you' ? activity.get(session.id) : undefined,
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
  /** Some agent reported credits, so the total is shown in credits; dollars are only a fallback. */
  hasCredits: boolean;
  /** False when no agent has reported any cost yet, so no total is shown rather than a zero. */
  hasCost: boolean;
  /** Some agent lacks the shown currency (dollar-only beside credits, or no cost), so the total is a floor. */
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
  const hasCredits = agents.some(agent => agent.credits !== undefined);
  const hasCost = hasCredits || agents.some(agent => agent.usdCost !== undefined);
  const costPartial = hasCost && agents.some(agent => (hasCredits ? agent.credits : agent.usdCost) === undefined);
  return { total: agents.length, counts, usdCost, credits, hasCredits, hasCost, costPartial };
}

/** The roster's total in its shown currency, with '~' when it is a floor; undefined until any agent reports a cost. */
export function formatRosterCost(summary: RosterSummary): string | undefined {
  if (!summary.hasCost) return undefined;
  const total = summary.hasCredits ? formatAgentCost(undefined, summary.credits) : formatAgentCost(summary.usdCost);
  return `${summary.costPartial ? '~' : ''}${total}`;
}

/** Credits, worded as the rest of the app words them; dollars only for an agent that reported no credits. */
export function formatAgentCost(usdCost?: number, credits?: number): string {
  if (credits !== undefined) {
    // A sub-credit charge is still spending; rounding it to "0 credits" would say it was free.
    if (credits > 0 && Math.round(credits) === 0) return '<1 credit';
    return `${formatCredits(credits)} ${Math.round(credits) === 1 ? 'credit' : 'credits'}`;
  }
  if (usdCost !== undefined) return `$${usdCost.toFixed(2)}`;
  return '-';
}

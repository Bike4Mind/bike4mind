import type { ModelSelection, WorkerTask, RootPolicy } from '@shared/orchestration';
import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus, ChatSessionSummary, SessionSetupStep } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { descendantsOf } from '@shared/spawnTree';
import { formatCredits } from '../statusLine';
import type { AgentActivity } from './activity';
import {
  AGENT_STATE_PRIORITY,
  countAgentStates,
  deriveTaskAgentState,
  type AgentState,
  type AgentStateCounts,
} from '@shared/agentState';

export {
  AGENT_STATE_LABEL,
  AGENT_STATE_PRIORITY,
  deriveAgentState,
  deriveTaskAgentState,
  describeAgentStates,
  type AgentState,
} from '@shared/agentState';

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
  workerSelection?: ModelSelection;
  workerTask?: WorkerTask;
  orchestrationPolicy?: RootPolicy;
  state: AgentState;
  /** Working, but still being prepared: the setup step it is on. Stays 'working' for every count. */
  preparing?: SessionSetupStep;
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
  return descendantsOf(sessions, rootId).map(({ session }) => deriveTaskAgentState(session, statuses.get(session.id)));
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
  preparing?: ReadonlyMap<string, SessionSetupStep>;
  activity: ReadonlyMap<string, AgentActivity>;
  prSummaries: ReadonlyMap<string, PrSummary>;
  rootId: string;
}): AgentView[] {
  const { sessions, statuses, preparing, activity, prSummaries, rootId } = input;
  const views: AgentView[] = [];

  for (const { session, depth } of descendantsOf(sessions, rootId)) {
    const state = deriveTaskAgentState(session, statuses.get(session.id));
    const setup = state === 'working' ? preparing?.get(session.id) : undefined;
    views.push({
      id: session.id,
      title: session.title.trim() || 'Untitled agent',
      parentId: session.origin.parentSessionId,
      depth,
      seedPrompt: session.origin.seedPrompt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      workerSelection: session.workerSelection,
      workerTask: session.workerTask,
      orchestrationPolicy: session.orchestrationPolicy,
      state,
      ...(setup && { preparing: setup }),
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
  /** countAgentStates: 'needs-you' includes the parent when it waits on the user. */
  counts: AgentStateCounts;
  usdCost: number;
  credits: number;
  /** Some agent reported credits, so the total is shown in credits; dollars are only a fallback. */
  hasCredits: boolean;
  /** False when no agent has reported any cost yet, so no total is shown rather than a zero. */
  hasCost: boolean;
  /** Some agent lacks the shown currency (dollar-only beside credits, or no cost), so the total is a floor. */
  costPartial: boolean;
}

export function summarizeRoster(agents: readonly AgentView[], parent?: ParentView): RosterSummary {
  const counts = countAgentStates(
    agents.map(agent => agent.state),
    parent?.status === 'needs-action' ? 1 : 0
  );
  let usdCost = 0;
  let credits = 0;
  for (const agent of agents) {
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

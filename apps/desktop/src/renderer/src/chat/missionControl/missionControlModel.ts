import { countAgentStates, deriveTaskAgentState } from '@shared/agentState';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { orchestrationTest } from '../orchestrator/panePins';
import { agentStates, descendantIds } from '../orchestrator/roster';

/**
 * Mission Control's tiles: one per top-level orchestration (panePins.orchestrationTest, the same rule as the
 * pane picker's "Other orchestrations", uncapped). Pure, so the view and tests share one rule.
 */

export interface MissionControlCounts {
  working: number;
  needsYou: number;
  done: number;
  failed: number;
  total: number;
}

export interface MissionControlTile {
  id: string;
  title: string;
  /** The project or repository name; absent for a session with none, and while presenting. */
  project?: string;
  counts: MissionControlCounts;
  /** The orchestrating session itself, or any agent under it, is waiting on the user. */
  needsYou: boolean;
  /** The orchestrating session or any agent is running. */
  working: boolean;
  /** The latest `updatedAt` across the session and its agents (ISO). */
  lastActivity: string;
}

type TileSession = Pick<
  ChatSessionSummary,
  'id' | 'title' | 'updatedAt' | 'archived' | 'origin' | 'orchestrate' | 'project' | 'workerTask' | 'lastOutcome'
>;

function buildTile(
  root: TileSession,
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>
): MissionControlTile {
  const rootState = deriveTaskAgentState(root, statuses.get(root.id));
  const counts = countAgentStates(agentStates(sessions, statuses, root.id), rootState === 'needs-you' ? 1 : 0);
  const agentIds = descendantIds(sessions, root.id);
  const lastActivity = sessions
    .filter(session => agentIds.has(session.id))
    .reduce((latest, session) => (session.updatedAt > latest ? session.updatedAt : latest), root.updatedAt);
  const project = root.project?.name.trim();
  return {
    id: root.id,
    title: root.title,
    ...(project ? { project } : {}),
    counts: {
      working: counts.working,
      needsYou: counts['needs-you'],
      done: counts.done,
      failed: counts.failed,
      total: counts.total,
    },
    needsYou: counts['needs-you'] > 0,
    working: counts.working > 0 || rootState === 'working',
    lastActivity,
  };
}

export function buildTiles(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>
): MissionControlTile[] {
  const orchestrates = orchestrationTest(sessions);
  return sessions
    .filter(session => !session.archived && orchestrates(session))
    .map(root => buildTile(root, sessions, statuses));
}

/** What wants the user first, then what is running, then the most recently active. */
export function sortTiles(tiles: readonly MissionControlTile[]): MissionControlTile[] {
  return [...tiles].sort(
    (a, b) =>
      Number(b.needsYou) - Number(a.needsYou) ||
      Number(b.working) - Number(a.working) ||
      b.lastActivity.localeCompare(a.lastActivity)
  );
}

/** Presenter mode (orchestrator/presenter.ts): titles become "Session N" in shown order and projects go. */
export function presentTiles(tiles: readonly MissionControlTile[], presenting: boolean): MissionControlTile[] {
  if (!presenting) return [...tiles];
  return tiles.map(({ project: _project, ...tile }, index) => ({ ...tile, title: `Session ${index + 1}` }));
}

/** Narrows by title, case-insensitively; a blank query keeps every tile. */
export function filterTiles(tiles: readonly MissionControlTile[], query: string): MissionControlTile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tiles];
  return tiles.filter(tile => tile.title.toLowerCase().includes(needle));
}

/**
 * The tiles as shown: sorted, redacted while presenting, then filtered. Filtering runs on the shown titles,
 * so typing while presenting cannot probe a hidden one.
 */
export function missionControlTiles(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  { presenting, query }: { presenting: boolean; query: string }
): MissionControlTile[] {
  return filterTiles(presentTiles(sortTiles(buildTiles(sessions, statuses)), presenting), query);
}

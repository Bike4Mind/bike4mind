import type { ChatSessionSummary } from '@shared/chat';
import type { OrchestratorPane } from './orchestratorLayout';

/**
 * Which session a stage pane shows (OrchestratorPane.sessionId), and the sessions a pane can be pinned to.
 * Pure, so the stage (OrchestratorStage), the pane picker (PaneSessionMenu) and tests share one rule.
 */

export type PinRelation = 'parent' | 'child' | 'other';

export interface PinOption {
  sessionId: string;
  relation: PinRelation;
  label: string;
}

/** Other orchestrations offered besides the active session's parent and children, most recent first. */
export const MAX_OTHER_PIN_OPTIONS = 8;

type PinnableSession = Pick<ChatSessionSummary, 'id' | 'title' | 'updatedAt' | 'archived' | 'origin' | 'orchestrate'>;

/**
 * The session a pane shows when it is not the active one, else undefined (draw the active session). A single
 * pane, a pin to the active session, and a pin to a session no longer listed all follow the active session.
 */
export function resolvePaneSession<Session extends PinnableSession>(
  pane: Pick<OrchestratorPane, 'sessionId'>,
  { activeId, sessions, split }: { activeId: string | undefined; sessions: readonly Session[]; split: boolean }
): Session | undefined {
  const pinned = pane.sessionId;
  if (!split || pinned === undefined || pinned === activeId) return undefined;
  return sessions.find(session => session.id === pinned);
}

export function relationTo(
  session: PinnableSession,
  activeId: string | undefined,
  sessions: readonly PinnableSession[]
): PinRelation {
  const active = sessions.find(candidate => candidate.id === activeId);
  if (active?.origin?.parentSessionId === session.id) return 'parent';
  if (activeId !== undefined && session.origin?.parentSessionId === activeId) return 'child';
  return 'other';
}

/** Presenter mode (presenter.ts) hides titles, so a pin is named by its relation and position alone. */
function optionLabel(session: PinnableSession, relation: PinRelation, ordinal: number, presenting: boolean): string {
  if (relation === 'parent') return presenting ? 'Parent session' : `Parent: ${session.title}`;
  if (relation === 'child') return presenting ? `Child session ${ordinal}` : `Child: ${session.title}`;
  return presenting ? `Session ${ordinal}` : session.title;
}

const newestFirst = (a: PinnableSession, b: PinnableSession) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Whether a session is a top-level orchestration: one that orchestrates or already has agents. Shared by the
 * pane picker's "Other orchestrations" and Mission Control (missionControl/missionControlModel.ts).
 */
export function orchestrationTest(
  sessions: readonly Pick<ChatSessionSummary, 'origin'>[]
): (session: Pick<ChatSessionSummary, 'id' | 'origin' | 'orchestrate'>) => boolean {
  const withAgents = new Set(sessions.flatMap(session => session.origin?.parentSessionId ?? []));
  return session => !session.origin && (session.orchestrate === true || withAgents.has(session.id));
}

/**
 * What a pane can be pinned to, besides following the active session: its parent, its children, then up to
 * `limit` other top-level orchestrations (a session that orchestrates or already has agents).
 */
export function pinOptions(
  activeId: string | undefined,
  sessions: readonly PinnableSession[],
  { presenting = false, limit = MAX_OTHER_PIN_OPTIONS }: { presenting?: boolean; limit?: number } = {}
): PinOption[] {
  const live = sessions.filter(session => !session.archived && session.id !== activeId);
  const parentId = sessions.find(session => session.id === activeId)?.origin?.parentSessionId;
  const parent = live.find(session => session.id === parentId);
  const children = activeId === undefined ? [] : live.filter(s => s.origin?.parentSessionId === activeId);
  const orchestrates = orchestrationTest(sessions);
  const others = live
    .filter(s => s.id !== parentId && orchestrates(s))
    .sort(newestFirst)
    .slice(0, limit);

  const toOptions = (group: readonly PinnableSession[], relation: PinRelation) =>
    group.map((session, index) => ({
      sessionId: session.id,
      relation,
      label: optionLabel(session, relation, index + 1, presenting),
    }));
  return [
    ...toOptions(parent ? [parent] : [], 'parent'),
    ...toOptions([...children].sort(newestFirst), 'child'),
    ...toOptions(others, 'other'),
  ];
}

/** The name a pinned pane is shown under: its option's label, else (a session past the cap) one of its own. */
export function pinLabel(
  session: PinnableSession,
  activeId: string | undefined,
  sessions: readonly PinnableSession[],
  { presenting = false }: { presenting?: boolean } = {}
): string {
  const option = pinOptions(activeId, sessions, { presenting, limit: Number.POSITIVE_INFINITY }).find(
    candidate => candidate.sessionId === session.id
  );
  if (option) return option.label;
  return presenting ? 'Pinned session' : optionLabel(session, relationTo(session, activeId, sessions), 1, false);
}

import type { ChatSessionMode, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { alertableSessions, rootSessionOf } from '@shared/needsYou';
import { pendingDecisionOf } from '@shared/orchestration';

/**
 * The Agents place's board: every session the dock badge counts (needsYouBadgeCount), so the rail
 * badge, the dock badge and the rows on the board are always the same number. A session is on it
 * while its status is 'needs-action', which SessionActivity sets for a turn parked on the user and
 * for a finished reply nobody has opened yet (`unreadReply`). Opening the session clears either.
 */

export type BoardGroupKey = 'waiting' | 'failed' | 'finished';

export const BOARD_GROUP_LABEL: Record<BoardGroupKey, string> = {
  waiting: 'Waiting on you',
  failed: 'Failed',
  finished: 'Finished',
};

/** Blocked work first, then turns that broke, then replies that only need reading. */
const GROUP_ORDER: readonly BoardGroupKey[] = ['waiting', 'failed', 'finished'];

export const WAITING_FALLBACK_DETAIL = 'Waiting for your approval or answer';
export const FAILED_FALLBACK_DETAIL = 'The last turn ended with an error';

export interface BoardEntry {
  id: string;
  title: string;
  mode: ChatSessionMode;
  group: BoardGroupKey;
  /** The decision asked, or the last reply's excerpt; absent when there is nothing to quote. */
  detail?: string;
  /** "Agent of <root>" or "Side chat of <root>" for a session another one started. */
  context?: string;
  updatedAt: string;
}

export interface BoardGroup {
  key: BoardGroupKey;
  label: string;
  entries: BoardEntry[];
}

type BoardSession = Pick<
  ChatSessionSummary,
  'id' | 'title' | 'mode' | 'updatedAt' | 'origin' | 'workerTask' | 'lastOutcome' | 'lastSnippet'
>;

function groupOf(session: BoardSession, unread: boolean): BoardGroupKey {
  if (!unread) return 'waiting';
  return session.lastOutcome === 'failed' ? 'failed' : 'finished';
}

function detailOf(session: BoardSession, group: BoardGroupKey): string | undefined {
  if (group === 'waiting') return pendingDecisionOf(session.workerTask)?.question.question ?? WAITING_FALLBACK_DETAIL;
  const snippet = session.lastSnippet?.trim();
  if (snippet) return snippet;
  return group === 'failed' ? FAILED_FALLBACK_DETAIL : undefined;
}

function contextOf(session: BoardSession, sessions: readonly ChatSessionSummary[]): string | undefined {
  if (!session.origin) return undefined;
  const rootId = rootSessionOf(sessions, session.id);
  if (rootId === session.id) return undefined;
  const rootTitle = sessions.find(candidate => candidate.id === rootId)?.title.trim() || 'Untitled session';
  return `${session.origin.kind === 'side-chat' ? 'Side chat' : 'Agent'} of ${rootTitle}`;
}

/** The board's groups in order, newest first within each; groups with nothing in them are left out. */
export function agentsBoard(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  unreadReplies: ReadonlySet<string>
): BoardGroup[] {
  const alertable = alertableSessions(sessions, 'all');
  const entries: BoardEntry[] = sessions
    .filter(session => alertable.has(session.id) && statuses.get(session.id) === 'needs-action')
    .map(session => {
      const group = groupOf(session, unreadReplies.has(session.id));
      const detail = detailOf(session, group);
      const context = contextOf(session, sessions);
      return {
        id: session.id,
        title: session.title.trim() || 'Untitled session',
        mode: session.mode,
        group,
        ...(detail ? { detail } : {}),
        ...(context ? { context } : {}),
        updatedAt: session.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return GROUP_ORDER.map(key => ({
    key,
    label: BOARD_GROUP_LABEL[key],
    entries: entries.filter(entry => entry.group === key),
  })).filter(group => group.entries.length > 0);
}

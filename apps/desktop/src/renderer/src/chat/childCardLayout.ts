import { isUnfinishedOutcome } from '@shared/agentOutcome';
import type {
  ChatChildReport,
  ChatChildWaiting,
  ChatMessage,
  ChatSessionStatus,
  ChatSessionSummary,
} from '@shared/chat';
import { childChipState } from './ChildrenStrip';

/** What a child's card says it is doing now. */
export type ChildCardState = 'needs-you' | 'working' | 'failed' | 'finished';

// Whatever wants the user sorts first; finished work last, where it is dimmed.
const STATE_RANK: Record<ChildCardState, number> = { 'needs-you': 0, working: 1, failed: 2, finished: 3 };

export interface ChildCard {
  sessionId: string;
  /** The live session's title, else the one its report carried; absent when neither is known. */
  title?: string;
  state: ChildCardState;
  /** What it waits on now; only while `state` is 'needs-you', so an answered ask never lingers. */
  waiting?: ChatChildWaiting;
  /** How many times it has stopped to ask, counting every waiting notice it left here. */
  asks: number;
  /** Its latest settled report, when it has one. */
  report?: { message: ChatMessage; report: ChatChildReport };
  /** Every notice and report it left in this thread, oldest first. */
  history: ChatMessage[];
}

export interface ChildCardsLive {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
}

export interface ChildCardLayout {
  cards: ChildCard[];
  /** The messages folded into a card, which the thread no longer draws on their own. */
  folded: ReadonlySet<string>;
  /** Where the stack is drawn: the index of the latest folded message, or -1 when there are none. */
  anchor: number;
}

/** The child a notice or report is about; undefined for a message from no child, or a notice too old to say. */
export function noticeChildId(message: ChatMessage): string | undefined {
  if (!message.system) return undefined;
  return message.childWaiting?.sessionId ?? message.reportedChildId ?? message.childReport?.sessionId;
}

function cardState(
  sessionId: string,
  latest: ChatMessage,
  report: ChatChildReport | undefined,
  live: ChildCardsLive | undefined,
  session: ChatSessionSummary | undefined
): ChildCardState {
  const waitingLast = latest.childWaiting !== undefined;
  const status = live?.statuses.get(sessionId);
  if (!live || (!session && status === undefined)) {
    // Nothing live to go on (a pane without the session list, or a child since deleted): the latest notice says it.
    if (waitingLast) return 'needs-you';
    return report && isUnfinishedOutcome(report.outcome) ? 'failed' : 'finished';
  }
  // A settled child with an unread reply is 'needs-action' too; a report newer than any ask is that case.
  if (status === 'needs-action' && !waitingLast) return isUnfinishedOutcome(report?.outcome) ? 'failed' : 'finished';
  const chip = childChipState(status, session?.lastOutcome ?? report?.outcome);
  return chip === 'needs-action' ? 'needs-you' : chip === 'processing' ? 'working' : chip;
}

/**
 * One card per child session that has left a notice or report in this thread, most urgent first
 * and most recently heard from first within a state. Notices stored before `childWaiting` existed
 * name no child, so they stay in the thread as they were.
 */
export function childCardLayout(messages: readonly ChatMessage[], live?: ChildCardsLive): ChildCardLayout {
  const byChild = new Map<string, { history: ChatMessage[]; last: number }>();
  const folded = new Set<string>();
  let anchor = -1;
  messages.forEach((message, index) => {
    const childId = noticeChildId(message);
    if (!childId) return;
    const entry = byChild.get(childId) ?? { history: [], last: index };
    entry.history.push(message);
    entry.last = index;
    byChild.set(childId, entry);
    folded.add(message.id);
    anchor = index;
  });

  const sessions = new Map(live?.sessions.map(session => [session.id, session]));
  const cards = [...byChild].map(([sessionId, { history, last }]) => {
    const latest = history.at(-1)!;
    const reportMessage = [...history].reverse().find(message => message.childReport);
    const report = reportMessage?.childReport;
    const session = sessions.get(sessionId);
    const state = cardState(sessionId, latest, report, live, session);
    const title = session?.title ?? report?.title;
    const card: ChildCard = {
      sessionId,
      ...(title ? { title } : {}),
      state,
      ...(state === 'needs-you' && latest.childWaiting ? { waiting: latest.childWaiting } : {}),
      asks: history.filter(message => message.childWaiting).length,
      ...(reportMessage && report ? { report: { message: reportMessage, report } } : {}),
      history,
    };
    return { card, last };
  });

  cards.sort((a, b) => STATE_RANK[a.card.state] - STATE_RANK[b.card.state] || b.last - a.last);
  return { cards: cards.map(entry => entry.card), folded, anchor };
}

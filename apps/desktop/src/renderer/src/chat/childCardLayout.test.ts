import type { ChatChildReport, ChatMessage, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { childCardLayout, noticeChildId } from './childCardLayout';

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 25, 9, 0, clock++)).toISOString();

function waitingNotice(sessionId: string, summary?: string): ChatMessage {
  return {
    id: `wait-${sessionId}-${clock}`,
    role: 'user',
    system: true,
    content: '[App notice: ...]',
    display: 'A session you started is waiting for you: an approval.',
    createdAt: at(),
    childWaiting: { sessionId, reason: 'approval', ...(summary ? { summary } : {}) },
  };
}

function reportMessage(sessionId: string, outcome: ChatChildReport['outcome'] = 'finished'): ChatMessage {
  return {
    id: `report-${sessionId}-${clock}`,
    role: 'user',
    system: true,
    content: '[report]',
    display: `The session "${sessionId}" has finished.`,
    createdAt: at(),
    childReport: { sessionId, title: `${sessionId} title`, outcome, branch: `agent/${sessionId}`, headSha: 'abc1234' },
    reportedChildId: sessionId,
  };
}

const chat = (id: string, role: 'user' | 'assistant'): ChatMessage => ({ id, role, content: id, createdAt: at() });

const session = (id: string, overrides: Partial<ChatSessionSummary> = {}) =>
  ({
    id,
    title: `${id} live title`,
    createdAt: at(),
    updatedAt: at(),
    messageCount: 1,
    origin: { kind: 'spawned', parentSessionId: 'parent' },
    ...overrides,
  }) as ChatSessionSummary;

const live = (sessions: ChatSessionSummary[], statuses: Array<[string, ChatSessionStatus]>) => ({
  sessions,
  statuses: new Map(statuses),
});

describe('childCardLayout', () => {
  it('folds every notice and report into one card per child, leaving the rest of the thread alone', () => {
    const messages = [
      chat('prompt', 'user'),
      waitingNotice('a', 'bash gh pr view 1'),
      waitingNotice('b'),
      waitingNotice('a', 'bash gh pr merge 1'),
      reportMessage('c'),
      chat('reply', 'assistant'),
      waitingNotice('a', 'bash gh pr checks 1'),
    ];
    const layout = childCardLayout(messages);

    expect(layout.cards.map(card => card.sessionId).sort()).toEqual(['a', 'b', 'c']);
    expect(layout.folded.has('prompt')).toBe(false);
    expect(layout.folded.has('reply')).toBe(false);
    expect(layout.folded.size).toBe(5);
    expect(layout.anchor).toBe(messages.length - 1);
  });

  it('counts repeated asks and shows only the latest one', () => {
    const layout = childCardLayout([
      waitingNotice('a', 'bash one'),
      waitingNotice('a', 'bash two'),
      waitingNotice('a', 'bash three'),
    ]);
    expect(layout.cards).toHaveLength(1);
    expect(layout.cards[0]).toMatchObject({ asks: 3, state: 'needs-you', waiting: { summary: 'bash three' } });
    expect(layout.cards[0]?.history).toHaveLength(3);
  });

  it('updates a card in place from live state, dropping an answered ask', () => {
    const messages = [waitingNotice('a', 'bash one')];
    const waiting = childCardLayout(messages, live([session('a')], [['a', 'needs-action']]));
    expect(waiting.cards[0]).toMatchObject({ state: 'needs-you', title: 'a live title' });

    const working = childCardLayout(messages, live([session('a')], [['a', 'processing']]));
    expect(working.cards).toHaveLength(1);
    expect(working.cards[0]?.state).toBe('working');
    expect(working.cards[0]?.waiting).toBeUndefined();

    const done = childCardLayout(messages, live([session('a', { lastOutcome: 'finished' })], []));
    expect(done.cards[0]?.state).toBe('finished');
    const failed = childCardLayout(messages, live([session('a', { lastOutcome: 'failed' })], []));
    expect(failed.cards[0]?.state).toBe('failed');
  });

  it('reads a settled child with an unread reply as finished, not as asking', () => {
    const layout = childCardLayout(
      [waitingNotice('a'), reportMessage('a')],
      live([session('a', { lastOutcome: 'finished' })], [['a', 'needs-action']])
    );
    expect(layout.cards[0]).toMatchObject({ state: 'finished', asks: 1 });
    expect(layout.cards[0]?.report?.report.branch).toBe('agent/a');
  });

  it('orders needs-you first, then working, then settled, newest first within a state', () => {
    const layout = childCardLayout(
      [
        waitingNotice('old-ask'),
        reportMessage('done'),
        waitingNotice('busy'),
        reportMessage('broke', 'failed'),
        waitingNotice('new-ask'),
      ],
      live(
        [
          session('old-ask'),
          session('done', { lastOutcome: 'finished' }),
          session('busy'),
          session('broke', { lastOutcome: 'failed' }),
          session('new-ask'),
        ],
        [
          ['old-ask', 'needs-action'],
          ['busy', 'processing'],
          ['new-ask', 'needs-action'],
        ]
      )
    );
    expect(layout.cards.map(card => [card.sessionId, card.state])).toEqual([
      ['new-ask', 'needs-you'],
      ['old-ask', 'needs-you'],
      ['busy', 'working'],
      ['broke', 'failed'],
      ['done', 'finished'],
    ]);
  });

  it('leaves a notice stored before notices named their child in the thread', () => {
    const legacy: ChatMessage = {
      id: 'legacy',
      role: 'user',
      system: true,
      content: '[App notice]',
      display: 'A session you started is waiting for you: an approval.',
      createdAt: at(),
    };
    expect(noticeChildId(legacy)).toBeUndefined();
    expect(childCardLayout([legacy]).folded.size).toBe(0);
  });
});

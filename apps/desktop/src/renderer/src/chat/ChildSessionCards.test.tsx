// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so the thread's follow-the-bottom scroll has nothing to call.
Element.prototype.scrollIntoView ??= () => undefined;

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 25, 9, 0, clock++)).toISOString();

const waiting = (sessionId: string, summary: string): ChatMessage => ({
  id: `wait-${clock}`,
  role: 'user',
  system: true,
  content: '[App notice]',
  display: 'A session you started is waiting for you: an approval.',
  createdAt: at(),
  childWaiting: { sessionId, reason: 'approval', summary },
});

const report = (sessionId: string): ChatMessage => ({
  id: `report-${clock}`,
  role: 'user',
  system: true,
  content: '[report]',
  display: `The session "${sessionId}" has finished.`,
  createdAt: at(),
  childReport: { sessionId, title: sessionId, outcome: 'finished', reply: 'All checks pass.' },
  reportedChildId: sessionId,
});

function session(id: string, title: string, overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id,
    title,
    createdAt: at(),
    updatedAt: at(),
    messageCount: 1,
    origin: { kind: 'spawned', parentSessionId: 'parent' },
    ...overrides,
  } as ChatSessionSummary;
}

describe('ChildSessionCards in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const sessions = [
    session('veyra', 'PR#8514 | payment-action'),
    session('fiora', 'PR#1393 | data-subject registry'),
    session('wulfric', 'PR#8536 | scripts test', { lastOutcome: 'finished' }),
  ];

  const render = (
    messages: ChatMessage[],
    statuses: Array<[string, ChatSessionStatus]>,
    listed: ChatSessionSummary[] = sessions
  ) =>
    act(() => {
      root.render(
        <MessageThread
          messages={messages}
          sessionId="parent"
          streaming={false}
          onRespond={() => undefined}
          onContinue={() => undefined}
          childSessions={{ sessions: listed, statuses: new Map(statuses) }}
        />
      );
    });

  const cards = () => [...container.querySelectorAll<HTMLElement>('[data-testid="child-session-card"]')];
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="child-session-row"]')];
  const cardOf = (id: string) => cards().find(card => card.dataset.sessionId === id)!;
  const rowOf = (id: string) => rows().find(row => row.dataset.sessionId === id)!;
  const text = (element: HTMLElement, testId: string) =>
    element.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  const click = (element: ParentNode, testId: string) =>
    act(() => element.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());

  const flood = [
    { id: 'prompt', role: 'user', content: 'Review and land these PRs', createdAt: at() } as ChatMessage,
    waiting('veyra', 'bash gh pr view 8514'),
    waiting('fiora', 'bash gh pr checks 1393'),
    waiting('veyra', 'bash gh pr diff 8514'),
    waiting('wulfric', 'bash pnpm test'),
    report('wulfric'),
    waiting('fiora', 'bash gh pr review 1393 --approve'),
    waiting('veyra', 'bash gh pr merge 8514'),
  ];

  it('gives a child that needs you a full card and lists the rest one line each', () => {
    render(flood, [
      ['veyra', 'needs-action'],
      ['fiora', 'processing'],
    ]);

    expect(container.querySelectorAll('[data-testid="chat-message-system"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="child-session-cards"]')).toHaveLength(1);
    expect(cards().map(card => [card.dataset.sessionId, card.dataset.state])).toEqual([['veyra', 'needs-you']]);
    expect(rows().map(row => [row.dataset.sessionId, row.dataset.state])).toEqual([
      ['fiora', 'working'],
      ['wulfric', 'finished'],
    ]);
    expect(text(container, 'child-session-list-summary')).toBe('2 sub-sessions · 1 working · 1 finished');
    expect(container.textContent).toContain('Review and land these PRs');
  });

  it('names the session and the latest ask, with a count of repeated asks', () => {
    render(flood, [['veyra', 'needs-action']]);
    const veyra = cardOf('veyra');
    expect(veyra.textContent).toContain('PR#8514 | payment-action');
    expect(text(veyra, 'child-session-card-headline')).toBe('Approve: bash gh pr merge 8514');
    expect(text(veyra, 'child-session-card-asks')).toBe('3 asks');
  });

  it('moves a child between its card and its row as the ask is answered and asked again', () => {
    render(flood, [['veyra', 'needs-action']]);
    expect(cardOf('veyra')).toBeDefined();

    render(flood, [['veyra', 'processing']]);
    expect(cards()).toHaveLength(0);
    expect(rowOf('veyra').dataset.state).toBe('working');
    expect(text(rowOf('veyra'), 'child-session-row-meta')).toBe('working');

    render([...flood, waiting('veyra', 'bash gh pr merge 8514 --squash')], [['veyra', 'needs-action']]);
    expect(text(cardOf('veyra'), 'child-session-card-headline')).toBe('Approve: bash gh pr merge 8514 --squash');
    expect(text(cardOf('veyra'), 'child-session-card-asks')).toBe('4 asks');
  });

  it('keeps a finished child report and every earlier notice one click away', () => {
    render(flood, []);
    const wulfric = rowOf('wulfric');
    expect(wulfric.querySelector('[data-testid="child-session-row-detail"]')).toBeNull();
    click(wulfric, 'child-session-row-expand-btn');

    const history = wulfric.querySelector('[data-testid="child-session-row-history"]')!;
    expect(history.querySelectorAll('[data-testid="child-session-card-history-entry"]')).toHaveLength(1);
    expect(history.textContent).toContain('Approve: bash pnpm test');
    expect(history.querySelectorAll('[data-testid="child-report-card"]')).toHaveLength(1);
  });

  it('folds archived and deleted children behind one toggle, and links only the ones that still exist', () => {
    const shelved = session('shelved', 'PR#8790 | settings ux', { archived: true });
    render([report('wulfric'), report('shelved'), report('removed')], [], [...sessions, shelved]);

    expect(rows().map(row => row.dataset.sessionId)).toEqual(['wulfric']);
    expect(text(container, 'child-session-list-summary')).toBe('1 sub-session · 1 finished');
    const toggle = container.querySelector<HTMLElement>('[data-testid="child-session-gone-toggle"]')!;
    expect(toggle.textContent).toBe('Show 2 archived or deleted');

    click(container, 'child-session-gone-toggle');
    expect(toggle.textContent).toBe('Hide 2 archived or deleted');
    const goneRows = [...container.querySelectorAll<HTMLElement>('[data-testid="child-session-gone-list"] [data-testid="child-session-row"]')];
    expect(goneRows.map(row => [row.dataset.sessionId, row.dataset.gone])).toEqual(
      expect.arrayContaining([
        ['shelved', 'archived'],
        ['removed', 'deleted'],
      ])
    );
    const removed = goneRows.find(row => row.dataset.sessionId === 'removed')!;
    expect(removed.querySelector('[data-testid="child-session-row-open-link"]')).toBeNull();
    expect(removed.textContent).toContain('removed');
    const shelvedRow = goneRows.find(row => row.dataset.sessionId === 'shelved')!;
    expect(text(shelvedRow, 'child-session-row-gone')).toBe('archived');
  });

  it('keeps a stopped child as a full card with its error', () => {
    const failed: ChatMessage = {
      ...report('fiora'),
      display: 'The session "fiora" stopped with an error: boom',
      childReport: { sessionId: 'fiora', title: 'fiora', outcome: 'failed', branch: 'agent/fiora', headSha: 'abc1234' },
    };
    render([failed], []);
    const fiora = cardOf('fiora');
    expect(fiora.dataset.state).toBe('failed');
    expect(text(fiora, 'child-session-card-headline')).toBe('The session "fiora" stopped with an error: boom');
    expect(text(fiora, 'child-session-card-workspace')).toBe('agent/fiora @ abc1234');
  });

  it('drops a stale "has finished." from a child whose live state says it stopped', () => {
    const stopped = session('wulfric', 'PR#8536 | scripts test', { lastOutcome: 'failed' });
    render([report('wulfric')], [], [stopped]);
    const wulfric = cardOf('wulfric');
    expect(wulfric.dataset.state).toBe('failed');
    expect(text(wulfric, 'child-session-card-headline')).toBeNull();
    click(wulfric, 'child-session-card-history-btn');
    expect(wulfric.querySelector('[data-testid="child-session-card-history"]')!.textContent).toContain('has finished');
  });
});

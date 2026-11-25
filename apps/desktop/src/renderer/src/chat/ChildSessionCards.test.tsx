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

  const render = (messages: ChatMessage[], statuses: Array<[string, ChatSessionStatus]>) =>
    act(() => {
      root.render(
        <MessageThread
          messages={messages}
          sessionId="parent"
          streaming={false}
          onRespond={() => undefined}
          onContinue={() => undefined}
          childSessions={{ sessions, statuses: new Map(statuses) }}
        />
      );
    });

  const cards = () => [...container.querySelectorAll<HTMLElement>('[data-testid="child-session-card"]')];
  const cardOf = (id: string) => cards().find(card => card.dataset.sessionId === id)!;
  const text = (card: HTMLElement, testId: string) =>
    card.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

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

  it('draws one card per child instead of a card per notice, most urgent first', () => {
    render(flood, [
      ['veyra', 'needs-action'],
      ['fiora', 'processing'],
    ]);

    expect(container.querySelectorAll('[data-testid="chat-message-system"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="child-session-cards"]')).toHaveLength(1);
    expect(cards().map(card => [card.dataset.sessionId, card.dataset.state])).toEqual([
      ['veyra', 'needs-you'],
      ['fiora', 'working'],
      ['wulfric', 'finished'],
    ]);
    expect(container.textContent).toContain('Review and land these PRs');
  });

  it('names the session and the latest ask, with a count of repeated asks', () => {
    render(flood, [['veyra', 'needs-action']]);
    const veyra = cardOf('veyra');
    expect(veyra.textContent).toContain('PR#8514 | payment-action');
    expect(text(veyra, 'child-session-card-headline')).toBe('Approve: bash gh pr merge 8514');
    expect(text(veyra, 'child-session-card-asks')).toBe('3 asks');
    // One ask needs no count.
    expect(text(cardOf('wulfric'), 'child-session-card-asks')).toBeNull();
  });

  it('updates the same card in place once the ask is answered, and on a new ask', () => {
    render(flood, [['veyra', 'needs-action']]);
    const before = cardOf('veyra');

    render(flood, [['veyra', 'processing']]);
    expect(cardOf('veyra')).toBe(before);
    expect(before.dataset.state).toBe('working');
    expect(text(before, 'child-session-card-headline')).toBeNull();

    render([...flood, waiting('veyra', 'bash gh pr merge 8514 --squash')], [['veyra', 'needs-action']]);
    expect(cards()).toHaveLength(3);
    expect(text(cardOf('veyra'), 'child-session-card-headline')).toBe('Approve: bash gh pr merge 8514 --squash');
    expect(text(cardOf('veyra'), 'child-session-card-asks')).toBe('4 asks');
  });

  it('keeps every earlier notice and report one click away', () => {
    render(flood, []);
    const wulfric = cardOf('wulfric');
    expect(wulfric.querySelector('[data-testid="child-session-card-history"]')).toBeNull();
    act(() => wulfric.querySelector<HTMLButtonElement>('[data-testid="child-session-card-history-btn"]')!.click());

    const history = wulfric.querySelector('[data-testid="child-session-card-history"]')!;
    expect(history.querySelectorAll('[data-testid="child-session-card-history-entry"]')).toHaveLength(1);
    expect(history.textContent).toContain('Approve: bash pnpm test');
    expect(history.querySelectorAll('[data-testid="child-report-card"]')).toHaveLength(1);
  });
});

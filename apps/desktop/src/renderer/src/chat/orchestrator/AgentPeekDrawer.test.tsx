// @vitest-environment jsdom
import { act } from 'react';
import type { ChatMessage, ChatQueueEvent, ChatQueuedMessage, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPeekDrawer, useSessionMessages } from './AgentPeekDrawer';
import type { AgentView } from './roster';
import type { WorkerTask } from '@shared/orchestration';
import { assignPersonas } from '@shared/agentPersona';
import { agentFixture, createThemedMount, el, query, typeInto } from './testUtils';

let queueListener: ((event: ChatQueueEvent) => void) | null = null;
const queueListeners = new Set<(event: ChatQueueEvent) => void>();
const queueUnsubscribe = vi.fn();
const chat = {
  onStreamEvent: vi.fn(() => () => undefined),
  onQueueChanged: vi.fn((listener: (event: ChatQueueEvent) => void) => {
    queueListeners.add(listener);
    queueListener = event => queueListeners.forEach(notify => notify(event));
    return () => {
      queueListeners.delete(listener);
      queueUnsubscribe();
    };
  }),
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  sendQueuedMessageNow: vi.fn(),
  respondToApproval: vi.fn(),
  listModels: vi.fn(async () => ({ models: [] })),
  taskAction: vi.fn(),
};
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };
const onClose = vi.fn();
const themed = createThemedMount();

const renderDrawer = (agent: AgentView) =>
  themed.render(
    <AgentPeekDrawer
      agent={agent}
      persona={assignPersonas([agent]).get(agent.id)}
      onClose={onClose}
      actions={actions}
    />
  );

const sessionWith = (...contents: string[]) => ({
  messages: contents.map((content, index) => ({ id: `m${index}`, role: 'assistant', content })),
});

const awaitingCall = (approvalId: string, command: string): ChatToolCall => ({
  id: `call-${approvalId}`,
  name: 'bash_execute',
  input: { command },
  status: 'awaiting-approval',
  approvalId,
  approvalDetail: command,
});

const sessionWithMessages = (...messages: Array<Partial<ChatMessage>>) => ({
  messages: messages.map((message, index) => ({ id: `m${index}`, role: 'assistant', content: '', ...message })),
});

const input = () => el('orchestrator-peek-reply-input') as HTMLTextAreaElement;

const longTask = (): WorkerTask => ({
  version: 1,
  contract: {
    version: 1,
    outcome: 'Verify a bounded scene change with detailed acceptance evidence.',
    rationale: 'Keep lengthy task reports from overwhelming the scene.',
    role: 'implementation',
    paths: ['apps/desktop'],
    contextReferences: [],
    ownedChanges: ['Scene layout'],
    coordinationConstraints: [],
    nonGoals: [],
    acceptanceCriteria: Array.from(
      { length: 8 },
      (_, index) =>
        `Criterion ${index}: preserve scene geometry, keyboard navigation, task actions and readable evidence.`
    ),
    verification: ['Focused tests'],
    assumptions: [],
    escalationConditions: [],
  },
  automaticUpgrades: 0,
  resolvedDecisions: [],
  attempts: Array.from({ length: 3 }, (_, index) => ({
    id: `attempt-${index}`,
    model: 'worker',
    startedAt: '2026-10-01T00:00:00.000Z',
    trigger: 'initial' as const,
  })),
  state: {
    status: 'completed',
    accepted: false,
    changedPaths: ['apps/desktop/scene.tsx'],
    verification: Array.from({ length: 8 }, (_, index) => ({
      criterion: `Criterion ${index}`,
      command: 'pnpm test',
      outcome: 'passed' as const,
      evidence: 'Measured artwork bounds before and after selection and checked every action in a narrow pane.',
    })),
    unmetCriteria: [],
    handoff: 'Detailed handoff with all verification results and observations.',
  },
});

async function typeAndSend(text: string) {
  await typeInto(input(), text);
  await act(async () => el('orchestrator-peek-send-btn').click());
}

const pressEnter = (init: KeyboardEventInit = {}) =>
  act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  queueListener = null;
  queueListeners.clear();
  chat.getSession.mockResolvedValue(sessionWith('message 1', 'message 2', 'message 3', 'message 4'));
  chat.sendMessage.mockResolvedValue({ ok: true, messageId: 'x' });
  chat.cancelQueuedMessage.mockResolvedValue(undefined);
  chat.sendQueuedMessageNow.mockResolvedValue(undefined);
  chat.respondToApproval.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { chat };
});

afterEach(() => {
  themed.unmount();
  vi.restoreAllMocks();
});

describe('AgentPeekDrawer', () => {
  it('acknowledges a focused opening once, not refreshes or stream events', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    function Messages({ refreshKey, visible }: { refreshKey: string; visible: boolean }) {
      useSessionMessages('a1', refreshKey, visible);
      return null;
    }
    await themed.render(<Messages refreshKey="first" visible />);
    const acknowledgements = () => chat.getSession.mock.calls.filter(([, viewed]) => viewed === true);
    expect(acknowledgements()).toHaveLength(1);
    await themed.render(<Messages refreshKey="next" visible />);
    vi.useFakeTimers();
    try {
      await act(async () => {
        queueListener?.({ sessionId: 'a1', queued: [] });
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(acknowledgements()).toHaveLength(1);
      expect(chat.getSession).toHaveBeenLastCalledWith('a1', false);
    } finally {
      vi.useRealTimers();
    }
    await themed.render(<Messages refreshKey="next" visible={false} />);
    await themed.render(<Messages refreshKey="next" visible />);
    expect(acknowledgements()).toHaveLength(2);
  });

  it('keeps the task title and state without a redundant persona subtitle', async () => {
    const agent = agentFixture('a1', 'working', { title: 'Fix the flaky login test' });
    await renderDrawer(agent);
    expect(query('orchestrator-peek-persona')).toBeNull();
    expect(document.body.textContent).toContain('Fix the flaky login test');
    expect(el('orchestrator-peek-conversation')).not.toBeNull();
  });

  it('shows the full conversation instead of only the last three messages', async () => {
    await renderDrawer(agentFixture('a1'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('message 1');
    expect(text).toContain('message 2');
    expect(text).toContain('message 4');
  });

  it('keeps reply and actions outside the scrollable conversation', async () => {
    await renderDrawer(agentFixture('a1', 'working'));
    const context = el('orchestrator-peek-conversation');
    expect(query('orchestrator-peek-context-toggle')).toBeNull();
    for (const action of ['reply-input', 'send-btn', 'open-btn', 'actions-menu-btn', 'close-btn']) {
      expect(context.contains(el(`orchestrator-peek-${action}`))).toBe(false);
    }
    expect(context.textContent).toContain('message 4');
    const style = getComputedStyle(el('orchestrator-peek-drawer'));
    expect(style.maxWidth).toBe('100%');
    expect(style.maxHeight).toBe('100%');
    expect(style.overflowY).toBe('hidden');
    expect(getComputedStyle(el('chat-thread')).overflowY).toBe('auto');
  });

  it('keeps approvals answerable without task-management sections', async () => {
    const workerTask = longTask();
    chat.getSession.mockResolvedValue(sessionWithMessages({ toolCalls: [awaitingCall('urgent', 'pnpm test')] }));
    chat.taskAction.mockResolvedValue({ workerTask });
    await renderDrawer(agentFixture('a1', 'needs-you', { workerTask }));
    expect(query('agent-task-details')).toBeNull();
    expect(query('agent-task-state')).toBeNull();
    expect(el('orchestrator-peek-conversation').contains(el('chat-tool-approval'))).toBe(true);
    await act(async () => el('chat-tool-approve-once').click());
    expect(chat.respondToApproval).toHaveBeenCalledWith('urgent', { decision: 'once' });
    expect(chat.taskAction).not.toHaveBeenCalled();
  });

  it('refetches when the agent updatedAt changes', async () => {
    await renderDrawer(agentFixture('a1'));
    expect(chat.getSession).toHaveBeenCalledTimes(1);
    chat.getSession.mockResolvedValue(sessionWith('fresh news'));
    await renderDrawer(agentFixture('a1', 'working', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    expect(chat.getSession).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('fresh news');
  });

  it('ignores a fetch that resolves after a newer one was requested', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    chat.getSession.mockReturnValueOnce(new Promise(resolve => (resolveFirst = resolve)));
    await renderDrawer(agentFixture('a1'));
    chat.getSession.mockResolvedValue(sessionWith('current'));
    await renderDrawer(agentFixture('a1', 'working', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    await act(async () => resolveFirst(sessionWith('outdated')));
    const text = document.body.textContent ?? '';
    expect(text).toContain('current');
    expect(text).not.toContain('outdated');
  });

  it('shows an inline error when the session cannot be read', async () => {
    chat.getSession.mockRejectedValue(new Error('disk gone'));
    await renderDrawer(agentFixture('a1'));
    expect(el('orchestrator-peek-load-error').textContent).toBe('disk gone');
  });

  it('sends the reply to the agent session', async () => {
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(chat.sendMessage).toHaveBeenCalledWith({ sessionId: 'a1', text: 'hello' });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
    expect(input().value).toBe('');
  });

  it('sends on Enter but not on Shift+Enter or while composing', async () => {
    await renderDrawer(agentFixture('a1'));
    await typeInto(input(), 'hello');
    await pressEnter({ shiftKey: true });
    await pressEnter({ isComposing: true });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    await pressEnter();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends once when Enter is pressed twice before the first send settles', async () => {
    let finish: (value: unknown) => void = () => {};
    chat.sendMessage.mockReturnValue(new Promise(resolve => (finish = resolve)));
    await renderDrawer(agentFixture('a1'));
    await typeInto(input(), 'hello');
    await pressEnter();
    await pressEnter();
    expect((el('orchestrator-peek-send-btn') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: true, messageId: 'x' }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the queued note, cancels, and sends now with the queued id', async () => {
    chat.sendMessage.mockResolvedValue({
      ok: true,
      queued: true,
      message: { id: 'q1', sessionId: 'a1', text: 'hello' },
    });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(el('orchestrator-peek-queued-note').textContent).toContain(
      'Queued - it will send when this agent finishes its current step.'
    );
    await act(async () => el('orchestrator-peek-queued-send-now-btn').click());
    expect(chat.sendQueuedMessageNow).toHaveBeenCalledWith('a1', 'q1');
    expect(query('orchestrator-peek-queued-note')).toBeNull();

    await typeAndSend('again');
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(chat.cancelQueuedMessage).toHaveBeenCalledWith('a1', 'q1');
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('clears the queued note once the message leaves that session queue', async () => {
    const message = { id: 'q1', sessionId: 'a1', text: 'hello' } as ChatQueuedMessage;
    chat.sendMessage.mockResolvedValue({ ok: true, queued: true, message });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(chat.onQueueChanged.mock.calls.length).toBeGreaterThanOrEqual(2);

    const emit = (event: ChatQueueEvent) => act(async () => queueListener?.(event));
    await emit({ sessionId: 'other', queued: [] });
    await emit({ sessionId: 'a1', queued: [message] });
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();

    await emit({ sessionId: 'a1', queued: [] });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('never shows the note when the queue drains before the send resolves', async () => {
    const message = { id: 'q1', sessionId: 'a1', text: 'hello' } as ChatQueuedMessage;
    // Main announces the enqueue, the reply ends and flushes it, and only then does the invoke resolve.
    chat.sendMessage.mockImplementation(async () => {
      queueListener?.({ sessionId: 'a1', queued: [message] });
      queueListener?.({ sessionId: 'a1', queued: [] });
      return { ok: true, queued: true, message };
    });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('unsubscribes from queue changes on unmount', async () => {
    chat.sendMessage.mockResolvedValue({ ok: true, queued: true, message: { id: 'q1', sessionId: 'a1', text: 'x' } });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('x');
    themed.unmount();
    expect(queueUnsubscribe.mock.calls.length).toBe(chat.onQueueChanged.mock.calls.length);
  });

  it('keeps the queued note and shows the error when settling it fails', async () => {
    chat.sendMessage.mockResolvedValue({
      ok: true,
      queued: true,
      message: { id: 'q1', sessionId: 'a1', text: 'hello' },
    });
    chat.cancelQueuedMessage.mockRejectedValue(new Error('too late'));
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(el('orchestrator-peek-error').textContent).toBe('too late');
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();
  });

  it('shows the error when the send is refused or throws', async () => {
    chat.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Signed out' });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(el('orchestrator-peek-error').textContent).toBe('Signed out');
    chat.sendMessage.mockRejectedValueOnce(new Error('ipc down'));
    await act(async () => el('orchestrator-peek-send-btn').click());
    expect(el('orchestrator-peek-error').textContent).toBe('ipc down');
  });

  it('hides Stop for a finished agent but offers it while working', async () => {
    await renderDrawer(agentFixture('a1', 'done'));
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    expect(query('orchestrator-peek-stop-btn')).toBeNull();
    themed.unmount();
    await renderDrawer(agentFixture('a1', 'working'));
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    await act(async () => el('orchestrator-peek-stop-btn').click());
    expect(actions.stop).toHaveBeenCalledWith('a1');
  });

  it('archives then closes', async () => {
    await renderDrawer(agentFixture('a1'));
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    await act(async () => el('orchestrator-peek-archive-btn').click());
    expect(actions.archive).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
  });

  it('aligns the split action left and Send right in one row, keeping Open as the primary action', async () => {
    await renderDrawer(agentFixture('a1'));
    const row = el('orchestrator-peek-action-row');
    expect(row.firstElementChild).toBe(el('orchestrator-peek-actions'));
    expect(row.lastElementChild).toBe(el('orchestrator-peek-send-btn'));
    expect(getComputedStyle(row).display).toBe('flex');
    expect(getComputedStyle(row).justifyContent).toBe('space-between');
    expect(query('orchestrator-peek-archive-btn')).toBeNull();
    await act(async () => el('orchestrator-peek-open-btn').click());
    expect(actions.open).toHaveBeenCalledWith('a1');
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    expect(el('orchestrator-peek-actions-menu-btn').getAttribute('aria-expanded')).toBe('true');
    expect(el('orchestrator-peek-stop-btn').textContent).toBe('Stop');
    expect(el('orchestrator-peek-archive-btn').textContent).toBe('Archive');
  });

  describe('pending requests', () => {
    const pendingSession = () =>
      sessionWithMessages({ content: 'Checking the tree' }, { toolCalls: [awaitingCall('ap-1', 'rm -rf build')] });

    it('shows the pending approval of a session that is not the active one', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      await renderDrawer(agentFixture('child-1', 'needs-you'));
      expect(chat.getSession).toHaveBeenCalledWith('child-1', false);
      const pending = el('orchestrator-peek-conversation');
      expect(pending.querySelector('[data-testid="chat-tool-approval"]')).not.toBeNull();
      expect(pending.textContent).toContain('rm -rf build');
    });

    it('answers through the same approval IPC the thread uses, then drops the card', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      await renderDrawer(agentFixture('child-1', 'needs-you'));
      chat.getSession.mockResolvedValue(
        sessionWithMessages({
          toolCalls: [{ ...awaitingCall('ap-1', 'rm -rf build'), status: 'done', approvalId: undefined }],
        })
      );
      await act(async () => el('chat-tool-approve-once').click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-1', { decision: 'once' });
      expect(query('chat-tool-approval')).toBeNull();
    });

    it('drops the card once the agent no longer needs the user', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      await renderDrawer(agentFixture('child-1', 'needs-you'));
      expect(query('chat-tool-approval')).not.toBeNull();
      chat.getSession.mockResolvedValue(
        sessionWithMessages({
          toolCalls: [{ ...awaitingCall('ap-1', 'ls'), status: 'running', approvalId: undefined }],
        })
      );
      await renderDrawer(agentFixture('child-1', 'working'));
      expect(chat.getSession).toHaveBeenCalledTimes(2);
      expect(query('chat-tool-approval')).toBeNull();
    });

    it('refetches while waiting so a second request shows up', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      const waiting = agentFixture('child-1', 'needs-you', {
        activity: { kind: 'tool', tool: 'bash_execute', detail: 'rm -rf build' },
      });
      await renderDrawer(waiting);
      chat.getSession.mockResolvedValue(sessionWithMessages({ toolCalls: [awaitingCall('ap-2', 'git push')] }));
      await renderDrawer({ ...waiting, activity: { kind: 'tool', tool: 'bash_execute', detail: 'git push' } });
      expect(el('orchestrator-peek-conversation').textContent).toContain('git push');
    });

    it('puts the card back with the error when the answer cannot be delivered', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      chat.respondToApproval.mockRejectedValue(new Error('gate gone'));
      await renderDrawer(agentFixture('child-1', 'needs-you'));
      await act(async () => el('chat-tool-approve-once').click());
      expect(el('orchestrator-peek-load-error').textContent).toBe('gate gone');
      expect(query('chat-tool-approval')).not.toBeNull();
    });

    it('answers an ask-the-user question with the thread question card', async () => {
      chat.getSession.mockResolvedValue(
        sessionWithMessages({
          toolCalls: [
            {
              id: 'q-call',
              name: 'ask_user',
              input: {
                questions: [
                  {
                    question: 'Which branch?',
                    options: [
                      { label: 'main', description: 'The default branch' },
                      { label: 'dev', description: 'The integration branch' },
                    ],
                  },
                ],
              },
              status: 'awaiting-approval',
              approvalId: 'ap-q',
            },
          ],
        })
      );
      await renderDrawer(agentFixture('child-1', 'needs-you'));
      expect(el('orchestrator-peek-conversation').textContent).toContain('Which branch?');
      await act(async () => el('chat-question-skip').click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-q', { decision: 'deny' });
    });
  });

  it('renders user text and tool-call-only messages through the shared thread', async () => {
    chat.getSession.mockResolvedValue(
      sessionWithMessages(
        { role: 'user', content: 'go' },
        { content: '' },
        { content: '', toolCalls: [{ id: 'c1', name: 'bash_execute', input: { command: 'ls' }, status: 'done' }] }
      )
    );
    await renderDrawer(agentFixture('a1'));
    expect(el('chat-message-user-text').textContent).toBe('go');
    expect(el('orchestrator-peek-conversation').textContent).toContain('ls');
    expect(query('orchestrator-peek-message')).toBeNull();
  });

  it('labels the drawer as a region and names the close button', async () => {
    await renderDrawer(agentFixture('a1'));
    const drawer = el('orchestrator-peek-drawer');
    expect(drawer.getAttribute('role')).toBe('region');
    expect(drawer.getAttribute('aria-label')).toMatch(/^Agent details: /);
    expect(el('orchestrator-peek-close-btn').getAttribute('aria-label')).toBe('Close agent details');
  });

  it('moves focus into the drawer on open and back to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await renderDrawer(agentFixture('a1'));
    expect(document.activeElement).toBe(el('orchestrator-peek-drawer'));
    themed.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not restore focus to an opener that left the document', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await renderDrawer(agentFixture('a1'));
    opener.remove();
    expect(() => themed.unmount()).not.toThrow();
    expect(document.activeElement).not.toBe(opener);
  });

  it('renders user and assistant turns with the shared message renderer', async () => {
    chat.getSession.mockResolvedValue(
      sessionWithMessages({ role: 'user', content: 'go' }, { role: 'assistant', content: 'on it' })
    );
    await renderDrawer(agentFixture('a1'));
    expect(el('chat-message-user-text').textContent).toBe('go');
    expect(el('chat-message-assistant').textContent).toContain('on it');
  });
});

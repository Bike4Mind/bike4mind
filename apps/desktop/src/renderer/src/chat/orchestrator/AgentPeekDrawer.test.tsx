// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import type { ChatModelOption, ChatMessage, ChatQueueEvent, ChatQueuedMessage, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPeekDrawer, useSessionMessages } from './AgentPeekDrawer';
import type { AgentView } from './roster';
import { inheritancePolicy, type WorkerTask } from '@shared/orchestration';
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
  getHeldRelays: vi.fn(),
  resolveHeldRelay: vi.fn(),
  regenerateReply: vi.fn(),
  sendMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  sendQueuedMessageNow: vi.fn(),
  respondToApproval: vi.fn(),
  listModels: vi.fn(async (): Promise<{ models: ChatModelOption[] }> => ({ models: [] })),
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
  chat.listModels.mockResolvedValue({ models: [] });
  chat.getHeldRelays.mockResolvedValue([]);
  chat.resolveHeldRelay.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
});

afterEach(() => {
  themed.unmount();
  vi.restoreAllMocks();
});

describe('AgentPeekDrawer', () => {
  it('acknowledges visible refreshed replies but not hidden content', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    function Messages({ refreshKey, visible }: { refreshKey: string; visible: boolean }) {
      useSessionMessages('a1', refreshKey, visible);
      return null;
    }
    await themed.render(<Messages refreshKey="first" visible />);
    const acknowledgements = () => chat.getSession.mock.calls.filter(([, viewed]) => viewed === true);
    expect(acknowledgements().length).toBeGreaterThan(0);
    const opened = acknowledgements().length;
    await themed.render(<Messages refreshKey="next" visible />);
    vi.useFakeTimers();
    try {
      await act(async () => {
        queueListener?.({ sessionId: 'a1', queued: [] });
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(acknowledgements().length).toBeGreaterThan(opened);
      expect(chat.getSession).toHaveBeenCalledWith('a1', true);
    } finally {
      vi.useRealTimers();
    }
    await themed.render(<Messages refreshKey="next" visible={false} />);
    const hidden = acknowledgements().length;
    await themed.render(<Messages refreshKey="hidden-update" visible={false} />);
    expect(acknowledgements()).toHaveLength(hidden);
    await themed.render(<Messages refreshKey="next" visible />);
    expect(acknowledgements().length).toBeGreaterThan(hidden);
  });

  it('shows the title and the full conversation, with reply and actions outside its scroll, as a named region', async () => {
    await renderDrawer(agentFixture('a1', 'working', { title: 'Fix the flaky login test' }));
    expect(query('orchestrator-peek-persona'), 'no redundant persona subtitle').toBeNull();
    expect(document.body.textContent).toContain('Fix the flaky login test');

    const context = el('orchestrator-peek-conversation');
    // The full conversation, not only the last three messages.
    for (const message of ['message 1', 'message 2', 'message 4']) expect(context.textContent).toContain(message);
    expect(query('orchestrator-peek-context-toggle')).toBeNull();
    for (const action of ['reply-input', 'send-btn', 'open-btn', 'actions-menu-btn', 'close-btn']) {
      expect(context.contains(el(`orchestrator-peek-${action}`)), action).toBe(false);
    }
    const style = getComputedStyle(el('orchestrator-peek-drawer'));
    expect(style.maxWidth).toBe('100%');
    expect(style.maxHeight).toBe('100%');
    expect(style.overflowY).toBe('hidden');
    expect(getComputedStyle(el('chat-thread')).overflowY).toBe('auto');

    const drawer = el('orchestrator-peek-drawer');
    expect(drawer.getAttribute('role')).toBe('region');
    expect(drawer.getAttribute('aria-label')).toMatch(/^Agent details: /);
    expect(el('orchestrator-peek-close-btn').getAttribute('aria-label')).toBe('Close agent details');
  });

  it('refetches when the agent updatedAt changes, ignoring a fetch that resolves after the newer one', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    chat.getSession.mockReturnValueOnce(new Promise(resolve => (resolveFirst = resolve)));
    await renderDrawer(agentFixture('a1'));
    chat.getSession.mockResolvedValue(sessionWith('current'));
    await renderDrawer(agentFixture('a1', 'working', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    expect(chat.getSession).toHaveBeenCalledTimes(2);
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

  it('shows a held relay and resolves it for the agent, not the open conversation', async () => {
    chat.getHeldRelays.mockResolvedValue([
      {
        id: 'h1',
        sessionId: 'a1',
        text: 'please merge',
        heldAt: '2026-10-01T00:00:00.000Z',
        reason: 'other-project',
        relay: { fromSessionId: 'x', fromTitle: 'Sender', hops: 1 },
      },
    ]);
    await renderDrawer(agentFixture('a1', 'needs-you'));
    expect(el('orchestrator-peek-held-relays').textContent).toContain('please merge');
    await act(async () => el('held-relay-deliver-btn').click());
    expect(chat.resolveHeldRelay).toHaveBeenCalledWith('a1', 'h1', true);
  });

  it('retries a failed turn, and says nothing when another surface already started it', async () => {
    chat.getSession.mockResolvedValue({
      messages: [
        { id: 'p', role: 'user', content: 'go', createdAt: '2026-10-01T00:00:00.000Z' },
        { id: 'r', role: 'assistant', content: '', error: 'Network down', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
    });
    chat.regenerateReply.mockResolvedValue({ ok: false, error: 'This conversation is still replying.', busy: true });
    await renderDrawer(agentFixture('a1', 'failed'));
    await act(async () => el('chat-message-assistant-regenerate-btn').click());
    expect(chat.regenerateReply).toHaveBeenCalledWith('a1');
    expect(query('orchestrator-peek-load-error')).toBeNull();

    chat.regenerateReply.mockResolvedValue({ ok: false, error: 'Sign in to regenerate this reply.' });
    await act(async () => el('chat-message-assistant-regenerate-btn').click());
    expect(el('orchestrator-peek-load-error').textContent).toBe('Sign in to regenerate this reply.');
  });

  it('offers no Regenerate on a finished worker, which would set its task running again', async () => {
    chat.getSession.mockResolvedValue({
      messages: [
        { id: 'p', role: 'user', content: 'go', createdAt: '2026-10-01T00:00:00.000Z' },
        { id: 'r', role: 'assistant', content: 'done', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
    });
    await renderDrawer(agentFixture('a1', 'done'));
    expect(query('chat-message-assistant')).not.toBeNull();
    expect(query('chat-message-assistant-regenerate-btn')).toBeNull();
  });

  it('sends the reply to the agent session on Enter, but not on Shift+Enter or while composing', async () => {
    await renderDrawer(agentFixture('a1'));
    await typeInto(input(), 'hello');
    await pressEnter({ shiftKey: true });
    await pressEnter({ isComposing: true });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    await pressEnter();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendMessage).toHaveBeenCalledWith({ sessionId: 'a1', text: 'hello' });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
    expect(input().value).toBe('');
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

    chat.cancelQueuedMessage.mockRejectedValueOnce(new Error('too late'));
    await typeAndSend('third');
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(el('orchestrator-peek-error').textContent, 'a failed settle keeps the note and says why').toBe('too late');
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();
  });

  it('clears the queued note once the message leaves that session queue', async () => {
    const message = { id: 'q1', sessionId: 'a1', text: 'hello' } as ChatQueuedMessage;
    chat.sendMessage.mockResolvedValue({ ok: true, queued: true, message });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(chat.onQueueChanged).toHaveBeenCalled();

    const emit = (event: ChatQueueEvent) => act(async () => queueListener?.(event));
    await emit({ sessionId: 'other', queued: [] });
    await emit({ sessionId: 'a1', queued: [message] });
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();

    await emit({ sessionId: 'a1', queued: [] });
    expect(query('orchestrator-peek-queued-note')).toBeNull();

    themed.unmount();
    expect(queueUnsubscribe.mock.calls.length, 'every queue subscription ends on unmount').toBe(
      chat.onQueueChanged.mock.calls.length
    );
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

  it('shows the error when the send is refused or throws', async () => {
    chat.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Signed out' });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(el('orchestrator-peek-error').textContent).toBe('Signed out');
    chat.sendMessage.mockRejectedValueOnce(new Error('ipc down'));
    await act(async () => el('orchestrator-peek-send-btn').click());
    expect(el('orchestrator-peek-error').textContent).toBe('ipc down');
  });

  it('hides Stop for a finished agent', async () => {
    await renderDrawer(agentFixture('a1', 'done'));
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    expect(query('orchestrator-peek-stop-btn')).toBeNull();
  });

  it('aligns the split action left and Send right in one row, keeping Open primary; Stop and Archive act', async () => {
    await renderDrawer(agentFixture('a1'));
    const row = el('orchestrator-peek-action-row');
    expect(row.firstElementChild).toBe(el('orchestrator-peek-actions'));
    expect(row.lastElementChild).toBe(el('orchestrator-peek-send-btn'));
    const rowStyle = getComputedStyle(row);
    expect(rowStyle.display).toBe('flex');
    expect(rowStyle.justifyContent).toBe('space-between');
    expect(query('orchestrator-peek-archive-btn')).toBeNull();
    await act(async () => el('orchestrator-peek-open-btn').click());
    expect(actions.open).toHaveBeenCalledWith('a1');
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    expect(el('orchestrator-peek-actions-menu-btn').getAttribute('aria-expanded')).toBe('true');
    expect(el('orchestrator-peek-stop-btn').textContent).toBe('Stop');
    expect(el('orchestrator-peek-archive-btn').textContent).toBe('Archive');
    await act(async () => el('orchestrator-peek-stop-btn').click());
    expect(actions.stop).toHaveBeenCalledWith('a1');
    await act(async () => el('orchestrator-peek-actions-menu-btn').click());
    await act(async () => el('orchestrator-peek-archive-btn').click());
    expect(actions.archive).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
  });

  describe('pending requests', () => {
    const pendingSession = () =>
      sessionWithMessages({ content: 'Checking the tree' }, { toolCalls: [awaitingCall('ap-1', 'rm -rf build')] });

    it('shows the pending approval of a non-active session and answers it through the thread IPC', async () => {
      chat.getSession.mockResolvedValue(pendingSession());
      await renderDrawer(agentFixture('child-1', 'needs-you', { workerTask: longTask() }));
      expect(chat.getSession).toHaveBeenCalledWith('child-1');
      expect(query('agent-task-details'), 'no task-management sections around the approval').toBeNull();
      expect(query('agent-task-state')).toBeNull();
      const pending = el('orchestrator-peek-conversation');
      expect(pending.querySelector('[data-testid="chat-tool-approval"]')).not.toBeNull();
      expect(pending.textContent).toContain('rm -rf build');
      chat.getSession.mockResolvedValue(
        sessionWithMessages({
          toolCalls: [{ ...awaitingCall('ap-1', 'rm -rf build'), status: 'done', approvalId: undefined }],
        })
      );
      await act(async () => el('chat-tool-approve-once').click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-1', { decision: 'once' });
      expect(chat.taskAction).not.toHaveBeenCalled();
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

  it('renders user, assistant and tool-call-only turns through the shared thread', async () => {
    chat.getSession.mockResolvedValue(
      sessionWithMessages(
        { role: 'user', content: 'go' },
        { content: '' },
        { content: '', toolCalls: [{ id: 'c1', name: 'bash_execute', input: { command: 'ls' }, status: 'done' }] },
        { content: 'on it' }
      )
    );
    await renderDrawer(agentFixture('a1'));
    expect(el('chat-message-user-text').textContent).toBe('go');
    expect(el('orchestrator-peek-conversation').textContent).toContain('ls');
    expect(document.body.textContent).toContain('on it');
    expect(query('orchestrator-peek-message'), 'no drawer-private renderer').toBeNull();
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
});

describe('structured task actions in the conversation drawer', () => {
  const openTaskControls = () => act(async () => el('orchestrator-peek-task-toggle').click());
  const taskNote = () => el('agent-task-note').querySelector('textarea') as HTMLTextAreaElement;

  it('keeps completed tasks reviewable after viewing and preserves the assessment while collapsed', async () => {
    const workerTask = longTask();
    if (workerTask.state.status !== 'completed') throw new Error('Expected a completed task fixture');
    chat.taskAction.mockResolvedValue({
      workerTask: { ...workerTask, state: { ...workerTask.state, accepted: true, assessment: 'Reviewed evidence' } },
    });
    await renderDrawer(agentFixture('a1', 'done', { workerTask }));
    expect(query('agent-task-panel')).toBeNull();
    expect(el('orchestrator-peek-task-toggle').getAttribute('aria-expanded')).toBe('false');
    await openTaskControls();
    expect(el('orchestrator-peek-task-toggle').getAttribute('aria-controls')).toBe(
      el('orchestrator-peek-task-controls').id
    );
    expect(el('orchestrator-peek-conversation').textContent).toContain('message 1');
    expect(el('orchestrator-peek-task-controls').contains(el('orchestrator-peek-reply-input'))).toBe(false);
    await typeInto(taskNote(), 'Reviewed evidence');
    await openTaskControls();
    expect(el('orchestrator-peek-task-controls').hidden).toBe(true);
    await openTaskControls();
    expect(taskNote().value).toBe('Reviewed evidence');
    await act(async () => el('agent-task-accept-btn').click());
    expect(chat.taskAction).toHaveBeenCalledTimes(1);
    expect(chat.taskAction).toHaveBeenCalledWith('a1', { kind: 'accept', assessment: 'Reviewed evidence' });
    expect(query('agent-task-accept-btn')).toBeNull();
  });

  // Deny is covered in TaskDecisionPanel.test.tsx; this checks the drawer reaches the upgrade select.
  it('makes an escalation approval reachable with its exact decision', async () => {
    const workerTask: WorkerTask = {
      ...longTask(),
      state: {
        status: 'escalation-requested',
        reason: 'The current model needs help',
        evidence: ['Observed the missing capability'],
        decisionId: 'upgrade-one',
        requestedModelId: 'premium',
      },
    };
    chat.listModels.mockResolvedValue({ models: [{ id: 'premium', name: 'Approved premium' }] });
    chat.taskAction.mockResolvedValue({ workerTask });
    await renderDrawer(
      agentFixture('a1', 'needs-you', {
        workerTask,
        orchestrationPolicy: {
          rootSessionId: 'parent',
          rootRunId: 'run',
          policy: {
            ...inheritancePolicy(),
            escalation: {
              mode: 'ask',
              allowedModels: ['premium'],
              allowedRoles: ['implementation'],
              maxAutomaticUpgrades: 0,
            },
          },
        },
      })
    );
    await openTaskControls();
    const selectRoot = el('agent-task-upgrade-select');
    const select = selectRoot.querySelector('button') ?? selectRoot;
    await act(async () => select.click());
    await act(async () => el('agent-task-upgrade-option-premium').click());
    await act(async () => el('agent-task-upgrade-btn').click());
    expect(chat.taskAction).toHaveBeenCalledWith('a1', {
      kind: 'upgrade',
      modelId: 'premium',
      decisionId: 'upgrade-one',
    });
    expect(chat.taskAction).toHaveBeenCalledTimes(1);
  });

  it('keeps blocked task revise and cancel reachable', async () => {
    const workerTask: WorkerTask = {
      ...longTask(),
      state: { status: 'blocked', reason: 'Need input', evidence: ['Observed missing detail'] },
    };
    chat.taskAction.mockResolvedValue({ workerTask });
    await renderDrawer(agentFixture('a1', 'needs-you', { workerTask }));
    await openTaskControls();
    await typeInto(taskNote(), 'Use the documented interface');
    await act(async () => el('agent-task-revise-btn').click());
    expect(chat.taskAction).toHaveBeenLastCalledWith('a1', {
      kind: 'revise',
      contract: workerTask.contract,
      instruction: 'Use the documented interface',
    });
    await typeInto(taskNote(), 'Not needed any more');
    await act(async () => el('agent-task-cancel-btn').click());
    expect(chat.taskAction).toHaveBeenLastCalledWith('a1', { kind: 'cancel', reason: 'Not needed any more' });
  });

  it('keeps cancellation reachable while the task is running', async () => {
    const workerTask: WorkerTask = { ...longTask(), state: { status: 'running' } };
    chat.taskAction.mockResolvedValue({
      workerTask: { ...workerTask, state: { status: 'canceled', reason: 'Canceled by user.' } },
    });
    await renderDrawer(agentFixture('a1', 'working', { workerTask }));
    await openTaskControls();
    await act(async () => el('agent-task-cancel-btn').click());
    expect(chat.taskAction).toHaveBeenCalledWith('a1', { kind: 'cancel', reason: 'Canceled by user.' });
  });

  it('starts closed with a fresh assessment when selecting another agent', async () => {
    await renderDrawer(agentFixture('a1', 'needs-you', { workerTask: longTask() }));
    await openTaskControls();
    await typeInto(taskNote(), 'Only for the first agent');
    await renderDrawer(agentFixture('a2', 'needs-you', { workerTask: longTask() }));
    expect(el('orchestrator-peek-task-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(query('agent-task-panel')).toBeNull();
    await openTaskControls();
    expect(taskNote().value).toBe('');
    expect(chat.taskAction).not.toHaveBeenCalled();
  });
});

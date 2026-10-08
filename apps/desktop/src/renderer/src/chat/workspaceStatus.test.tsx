// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatProject, ChatStreamEvent, SendMessageResult } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversation, type ConversationController } from './useChat';
import { workspacePhrase } from './workspaceProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 's1';

const awaiting: ChatProject = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: true,
  workingDirectory: '/repo',
  contextDirectories: [],
};

let latest: ConversationController | null = null;

function Harness() {
  const conversation = useConversation(SESSION, () => undefined);
  latest = conversation;
  return (
    <div>
      <span data-testid="status">{conversation.preparing ? workspacePhrase(conversation.preparing) : ''}</span>
      <span data-testid="prompts">{conversation.messages.filter(message => message.role === 'user').length}</span>
    </div>
  );
}

describe('the worktree status on a first turn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listener: ((event: ChatStreamEvent) => void) | null;
  let project: ChatProject;
  let resolveSend: (result: SendMessageResult) => void;

  const emit = (event: ChatStreamEvent) => act(() => listener?.(event));
  const status = () => container.querySelector('[data-testid="status"]')?.textContent ?? '';
  const prompts = () => Number(container.querySelector('[data-testid="prompts"]')?.textContent);

  beforeEach(() => {
    listener = null;
    project = awaiting;
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        getSession: async () => ({ id: SESSION, mode: 'code', project, messages: [] }),
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => undefined,
        onQueueChanged: () => () => undefined,
        onStreamEvent: (next: (event: ChatStreamEvent) => void) => {
          listener = next;
          return () => undefined;
        },
        sendMessage: () =>
          new Promise<SendMessageResult>(resolve => {
            resolveSend = resolve;
          }),
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  async function mount() {
    await act(async () => root.render(<Harness />));
    await act(async () => undefined);
  }

  function send(text: string): Promise<void> {
    let sent!: Promise<void>;
    act(() => {
      sent = latest?.send(text) ?? Promise.resolve();
    });
    return sent;
  }

  it('shows on the keystroke with the prompt, names the branch, and hands off to the turn', async () => {
    await mount();
    const sent = send('Fix the login form');

    expect(status()).toBe('Preparing worktree on main...');
    expect(prompts()).toBe(1);

    emit({ type: 'workspace', sessionId: SESSION, running: true, base: 'main' });
    emit({ type: 'workspace', sessionId: SESSION, running: true, base: 'main', branch: 'b4m/fix-abc123' });
    expect(status()).toBe('Creating branch b4m/fix-abc123 and worktree...');

    // Held until the turn takes over, so the line does not blink off in between.
    emit({ type: 'workspace', sessionId: SESSION, running: false, base: 'main' });
    expect(status()).toBe('Creating branch b4m/fix-abc123 and worktree...');

    emit({ type: 'start', sessionId: SESSION, messageId: 'm1' });
    expect(status()).toBe('');
    expect(latest?.turn).not.toBeNull();

    await act(async () => {
      resolveSend({ ok: true, messageId: 'm1' });
      await sent;
    });
    expect(status()).toBe('');
  });

  it('does not show on a turn whose session is already in its worktree', async () => {
    project = { ...awaiting, workspaceBranch: 'b4m/x-abc123', workingDirectory: '/repo/.b4m/worktrees/b4m+x-abc123' };
    await mount();

    const sent = send('second');

    expect(status()).toBe('');
    expect(prompts()).toBe(1);
    await act(async () => {
      resolveSend({ ok: true, messageId: 'm2' });
      await sent;
    });
  });

  it('clears, along with the pending prompt, when the worktree cannot be made', async () => {
    await mount();
    const sent = send('do the thing');
    emit({ type: 'workspace', sessionId: SESSION, running: true, base: 'main', branch: 'b4m/do-abc123' });
    emit({ type: 'workspace', sessionId: SESSION, running: false, base: 'main' });

    await act(async () => {
      resolveSend({ ok: false, error: 'already exists but is not a git worktree' });
      await sent;
    });

    expect(status()).toBe('');
    expect(prompts()).toBe(0);
    expect(latest?.sendError).toMatch(/not a git worktree/);
  });

  it('clears in a window that did not send once main reports the step over', async () => {
    await mount();
    emit({ type: 'workspace', sessionId: SESSION, running: true, base: 'main', branch: 'b4m/x-abc123' });
    expect(status()).toBe('Creating branch b4m/x-abc123 and worktree...');

    emit({ type: 'workspace', sessionId: SESSION, running: false, base: 'main' });

    expect(status()).toBe('');
  });
});

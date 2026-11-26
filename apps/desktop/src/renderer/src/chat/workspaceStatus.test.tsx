// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatProject, ChatStreamEvent, SendMessageResult } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation, type ConversationController } from './useChat';
import { workspacePhrase, applyWorkspaceEvent, preparingOnSend } from './workspaceProgress';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { useWorkspaceChanges } from './useWorkspaceChanges';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('workspaceStatus', () => {
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
        host: chatBackedHostBridge(),
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
        sent = (latest?.send(text) ?? Promise.resolve()).then(() => undefined);
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
});

describe('workspaceProgress', () => {
  const pending: ChatProject = {
    directory: '/repo',
    name: 'repo',
    branch: 'main',
    workspace: true,
    workingDirectory: '/repo',
    contextDirectories: [],
  };

  const event = (running: boolean, branch?: string) =>
    ({ type: 'workspace', sessionId: 's', running, base: 'main', ...(branch ? { branch } : {}) }) as const;

  describe('preparingOnSend', () => {
    it('shows the wait on the send that will cut the worktree', () => {
      expect(preparingOnSend(pending, false, 100)).toEqual({ since: 100, base: 'main' });
    });

    it('shows nothing once the session is in its worktree', () => {
      const moved = { ...pending, workspaceBranch: 'b4m/x-abc123', workingDirectory: '/repo/.b4m/worktrees/b4m+x' };
      expect(preparingOnSend(moved, false, 100)).toBeNull();
    });

    it('shows nothing with the toggle off, with no project, or behind a live turn', () => {
      expect(preparingOnSend({ ...pending, workspace: false }, false, 100)).toBeNull();
      expect(preparingOnSend(undefined, false, 100)).toBeNull();
      expect(preparingOnSend(pending, true, 100)).toBeNull();
    });
  });

  describe('applyWorkspaceEvent', () => {
    it('names the branch once main has chosen it, keeping the clock that started on send', () => {
      const shown = applyWorkspaceEvent({ since: 100, base: 'main' }, event(true, 'b4m/fix-abc123'), 500, true);
      expect(shown).toEqual({ since: 100, base: 'main', branch: 'b4m/fix-abc123' });
    });

    it('starts the clock for a window that did not send', () => {
      expect(applyWorkspaceEvent(null, event(true), 500, false)).toEqual({ since: 500, base: 'main' });
    });

    it('clears when the worktree step ends in a window with no send out', () => {
      expect(applyWorkspaceEvent({ since: 100, base: 'main', branch: 'b' }, event(false), 500, false)).toBeNull();
    });

    it('holds through the end of the step while this window waits on its own send', () => {
      const current = { since: 100, base: 'main', branch: 'b' };
      expect(applyWorkspaceEvent(current, event(false), 500, true)).toBe(current);
    });
  });

  describe('workspacePhrase', () => {
    it('reads the base before the branch is known, and the branch after', () => {
      expect(workspacePhrase({ since: 0, base: 'main' })).toBe('Preparing worktree on main...');
      expect(workspacePhrase({ since: 0, base: 'main', branch: 'b4m/fix-abc123' })).toBe(
        'Creating branch b4m/fix-abc123 and worktree...'
      );
    });
  });
});

describe('useWorkspaceChanges', () => {
  const PROJECT: ChatProject = {
    directory: '/repo',
    name: 'repo',
    branch: 'main',
    workspace: true,
    workspaceBranch: 'b4m/x-abc123',
    workingDirectory: '/repo/.b4m/worktrees/b4m+x-abc123',
    contextDirectories: [],
  };

  function changes(added: number): WorkspaceChanges {
    return { base: 'origin/main', added, removed: 0, fileCount: 1, files: [], commitsAhead: 0, uncommitted: 1 };
  }

  let seen: WorkspaceChanges | null = null;

  function Harness({ sessionId, settledTurns }: { sessionId: string | null; settledTurns: number }) {
    seen = useWorkspaceChanges(sessionId, sessionId ? PROJECT : undefined, settledTurns);
    return null;
  }

  describe('useWorkspaceChanges', () => {
    let container: HTMLDivElement;
    let root: Root;
    const workspaceChanges = vi.fn<(sessionId: string) => Promise<WorkspaceChanges | null>>();

    beforeEach(() => {
      seen = null;
      workspaceChanges.mockReset();
      (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat: { workspaceChanges } };
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    async function render(sessionId: string | null, settledTurns = 0): Promise<void> {
      await act(async () => root.render(<Harness sessionId={sessionId} settledTurns={settledTurns} />));
    }

    it('reads for the open session and re-reads when a reply settles', async () => {
      workspaceChanges.mockResolvedValueOnce(changes(3)).mockResolvedValueOnce(changes(7));

      await render('s1', 0);
      expect(seen).toMatchObject({ added: 3 });

      await render('s1', 1);
      expect(workspaceChanges).toHaveBeenCalledTimes(2);
      expect(seen).toMatchObject({ added: 7 });
    });

    it('re-reads on window focus, when the user may have committed in a terminal', async () => {
      workspaceChanges.mockResolvedValueOnce(changes(3)).mockResolvedValueOnce(null);
      await render('s1');

      await act(async () => window.dispatchEvent(new Event('focus')));

      expect(workspaceChanges).toHaveBeenCalledTimes(2);
      expect(seen).toBeNull();
    });

    it("never shows one session's reading under another while the new one is pending", async () => {
      workspaceChanges.mockResolvedValueOnce(changes(3)).mockReturnValueOnce(new Promise(() => undefined));
      await render('s1');
      expect(seen).toMatchObject({ added: 3 });

      await render('s2');

      expect(workspaceChanges).toHaveBeenLastCalledWith('s2');
      expect(seen).toBeNull();
    });

    it('asks nothing with no session open', async () => {
      await render(null);
      expect(workspaceChanges).not.toHaveBeenCalled();
      expect(seen).toBeNull();
    });
  });
});

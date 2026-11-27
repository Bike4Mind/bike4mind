// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  SendMessageResult,
  ChatSessionMode,
  CreateCodeSessionResult,
} from '@shared/chat';
import { useConversation, type ConversationController, useSessions, type SessionsController } from './useChat';
import type { GenerationSettings } from '@shared/generation';
import { CssVarsProvider } from '@mui/joy/styles';
import type { LoopResult } from '@shared/loop';
import { MessageThread } from './MessageThread';
import type { ShareDirectoryResult } from '@shared/directoryRequest';
import type { CreatedSession } from '@shared/ipc';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { groupSessions } from './grouping';
import { useSidebarSections } from './useSidebarSections';
import { chatBackedHostBridge, chatStubs } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('opening a chat', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const sessionFor = (id: string, patch: Partial<ChatSession> = {}): ChatSession => ({
    id,
    title: `Chat ${id}`,
    model: 'local:',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    messages: [],
    ...patch,
  });
  const summaryFor = (id: string, patch: Partial<ChatSessionSummary>): ChatSessionSummary => {
    const { messages, ...rest } = sessionFor(id);
    return { ...rest, messageCount: messages.length, ...patch } as ChatSessionSummary;
  };

  const compactContext = vi.fn();
  const clearContext = vi.fn();
  const setApprovalMode = vi.fn();
  const getSession = vi.fn<(id: string) => Promise<ChatSession | null>>();
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;

  function Harness({ id }: { id: string }) {
    conversation = useConversation(id, vi.fn());
    return null;
  }

  beforeEach(() => {
    for (const mock of [compactContext, clearContext, setApprovalMode, getSession]) mock.mockReset();
    getSession.mockImplementation(async id => sessionFor(id));
    const chat = {
      getSession,
      getQueuedMessages: async () => [],
      onSessionSummary: () => () => {},
      onQueueChanged: () => () => {},
      onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
      compactContext,
      clearContext,
      setApprovalMode,
    };
    Object.assign(window, {
      b4m: { host: chatBackedHostBridge(), chat, claudeImport: { onSessionsChanged: () => () => {} } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe.each([
    { command: 'compact', mock: compactContext },
    { command: 'clear', mock: clearContext },
  ])('/$command that lands after a switch', ({ command, mock }) => {
    const run = async (answer: unknown, then: 'resolve' | 'reject' = 'resolve') => {
      let settle: (value: unknown) => void = () => {};
      mock.mockReturnValue(new Promise((done, fail) => (settle = then === 'resolve' ? done : fail)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = conversation.runCommand(command, '');
      });
      expect(conversation.commandProgress !== null).toBe(command === 'compact');
      await act(async () => root.render(<Harness id="s2" />));
      expect(conversation.session?.id).toBe('s2');
      await act(async () => {
        settle(answer);
        await pending.catch(() => {});
      });
    };

    it('leaves the open chat its own session and messages', async () => {
      const mine = sessionFor('s1', { messages: [{ id: 'm', role: 'user', content: 'mine' } as never] });
      await run({ ok: true, session: mine });
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.messages).toEqual([]);
      expect(conversation.sendError).toBeNull();
      expect(conversation.commandProgress).toBeNull();
    });

    it('shows no error from the other chat', async () => {
      await run({ ok: false, error: 'nothing to do in s1' });
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.sendError).toBeNull();
    });

    it('still applies to the chat it ran in when that chat stays open', async () => {
      mock.mockResolvedValue({ ok: true, session: sessionFor('s1', { title: 'Done' }) });
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => conversation.runCommand(command, ''));
      expect(conversation.session?.title).toBe('Done');
      expect(conversation.commandProgress).toBeNull();
    });
  });

  describe.each([
    { command: 'compact', mock: compactContext },
    { command: 'clear', mock: clearContext },
  ])('/$command that lands during a reopen', ({ command, mock }) => {
    it('reads again when the superseded opening read rejects after the command succeeds', async () => {
      const after = sessionFor('s1', { title: 'Done' });
      let settle: (value: unknown) => void = () => {};
      mock.mockReturnValue(new Promise(done => (settle = done)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = conversation.runCommand(command, '');
      });
      await act(async () => root.render(<Harness id="s2" />));
      let rejectFirstRead: (error: Error) => void = () => {};
      let reads = 0;
      getSession.mockImplementation(async id => {
        if (id !== 's1') return sessionFor(id);
        reads++;
        return reads === 1 ? new Promise<ChatSession>((_, reject) => (rejectFirstRead = reject)) : after;
      });
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        settle({ ok: true, session: after });
        await pending;
      });
      expect(conversation.session?.title).toBe('Done');
      await act(async () => rejectFirstRead(new Error('superseded read failed')));
      expect(reads).toBe(2);
      expect(conversation.session?.title).toBe('Done');
      expect(conversation.sendError).toBeNull();
      expect(conversation.openFailedFor).toBeNull();
    });

    it('reads the chat again rather than putting back a transcript read before it', async () => {
      const message = { id: 'm', role: 'user', content: 'old' } as never;
      const after = sessionFor('s1', { title: 'Done' });
      let settle: (value: unknown) => void = () => {};
      mock.mockReturnValue(new Promise(done => (settle = done)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = conversation.runCommand(command, '');
      });
      await act(async () => root.render(<Harness id="s2" />));
      let answerFirstRead: (session: ChatSession) => void = () => {};
      let reads = 0;
      getSession.mockImplementation(async id => {
        if (id !== 's1') return sessionFor(id);
        reads++;
        return reads === 1 ? new Promise<ChatSession>(done => (answerFirstRead = done)) : after;
      });
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        settle({ ok: true, session: after });
        await pending;
      });
      await act(async () => answerFirstRead(sessionFor('s1', { messages: [message] })));
      expect(reads).toBe(2);
      expect(conversation.session?.title).toBe('Done');
      expect(conversation.messages).toEqual([]);
    });
  });

  describe('a failed chat read', () => {
    it.each(['summary', 'workspace'] as const)('retries a failed read invalidated by a %s event', async via => {
      let invalidate = () => {};
      if (via === 'summary') {
        chatStubs().onSessionSummary = listener => {
          invalidate = () => listener(summaryFor('s1', { title: 'Updated' }));
          return () => {};
        };
      } else {
        chatStubs().onStreamEvent = listener => {
          invalidate = () => listener({ type: 'workspace', sessionId: 's1', running: false, base: 'main' });
          return () => {};
        };
      }
      let rejectFirstRead: (error: Error) => void = () => {};
      getSession.mockImplementationOnce(() => new Promise<ChatSession>((_, reject) => (rejectFirstRead = reject)));
      getSession.mockResolvedValue(sessionFor('s1', { title: 'Updated' }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => invalidate());
      await act(async () => rejectFirstRead(new Error('superseded read failed')));
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(conversation.session?.title).toBe('Updated');
      expect(conversation.openFailedFor).toBeNull();
      expect(conversation.sendError).toBeNull();
    });

    it('clears the previous chat running state when the selected chat cannot be opened', async () => {
      getSession.mockImplementation(async id => {
        if (id === 's2') throw new Error('database locked');
        return sessionFor(id, { replyInFlight: { messageId: 'running-s1', startedAt: 10 } });
      });
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.streaming).toBe(true);
      expect(conversation.turn).not.toBeNull();
      await act(async () => root.render(<Harness id="s2" />));
      expect(conversation.openFailedFor).toBe('s2');
      expect(conversation.streaming).toBe(false);
      expect(conversation.turn).toBeNull();
    });

    it("drops Electron's remote method prefix from the reason", async () => {
      getSession.mockRejectedValue(
        new Error("Error invoking remote method 'chat:get-session': Error: database locked")
      );
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.sendError).toBe('Could not open this conversation. database locked');
    });

    it('shows the reason and ends the opening state when the first read fails', async () => {
      getSession.mockRejectedValue(new Error('database locked'));
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.sendError).toContain('database locked');
      expect(conversation.openFailedFor).toBe('s1');
      expect(conversation.session).toBeNull();
    });

    it('does the same for a non-Error rejection', async () => {
      getSession.mockRejectedValue('gone');
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.sendError).toContain('gone');
      expect(conversation.openFailedFor).toBe('s1');
    });

    it('shows the reason and ends the opening state when the re-read fails', async () => {
      let answerFirst: (session: ChatSession) => void = () => {};
      let reads = 0;
      getSession.mockImplementation(() => {
        reads++;
        if (reads === 1) return new Promise<ChatSession>(done => (answerFirst = done));
        return Promise.reject(new Error('read timed out'));
      });
      setApprovalMode.mockResolvedValue(summaryFor('s1', { approvalMode: 'auto' }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => conversation.setApprovalMode('auto'));
      await act(async () => answerFirst(sessionFor('s1')));
      expect(reads).toBe(2);
      expect(conversation.sendError).toContain('read timed out');
      expect(conversation.openFailedFor).toBe('s1');
    });

    it('ignores a failure that lands after a switch to another chat', async () => {
      let failFirst: (error: Error) => void = () => {};
      getSession.mockImplementation(id =>
        id === 's1' ? new Promise<ChatSession>((_, fail) => (failFirst = fail)) : Promise.resolve(sessionFor(id))
      );
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => failFirst(new Error('late failure')));
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.sendError).toBeNull();
      expect(conversation.openFailedFor).toBeNull();
    });

    it('opens normally again after a failed read when the chat is selected once more', async () => {
      getSession.mockRejectedValueOnce(new Error('database locked'));
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.openFailedFor).toBe('s1');
      await act(async () => root.render(<Harness id="s2" />));
      expect(conversation.openFailedFor).toBeNull();
      expect(conversation.sendError).toBeNull();
      expect(conversation.session?.id).toBe('s2');
    });
  });

  describe('a save for another chat while a chat is opening', () => {
    it('does not read the chat being opened again', async () => {
      let answerSecond: (session: ChatSession) => void = () => {};
      const reads: string[] = [];
      getSession.mockImplementation(id => {
        reads.push(id);
        return id === 's2' ? new Promise<ChatSession>(done => (answerSecond = done)) : Promise.resolve(sessionFor(id));
      });
      let landSave: (summary: ChatSessionSummary) => void = () => {};
      setApprovalMode.mockReturnValue(new Promise(done => (landSave = done)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = conversation.setApprovalMode('auto');
      });
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => {
        landSave(summaryFor('s1', { approvalMode: 'auto' }));
        await pending;
      });
      await act(async () => answerSecond(sessionFor('s2')));
      expect(reads.filter(id => id === 's2')).toHaveLength(1);
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.session?.approvalMode).toBe('ask');
    });
  });

  describe('a reply settled before the chat is opened', () => {
    let emit: (event: ChatStreamEvent) => void = () => {};
    const prompt = { id: 'p', role: 'user', content: 'please resume' } as never;
    const running = (messageId: string) =>
      sessionFor('s1', { messages: [prompt], replyInFlight: { messageId, startedAt: 10 } });
    const readsOf = (id: string) => getSession.mock.calls.filter(([read]) => read === id).length;

    beforeEach(() => {
      chatStubs().onStreamEvent = listener => {
        emit = listener;
        return () => {};
      };
    });

    // The window hears a session's events only while it shows it, so each reply settles in s1
    // while it is open and is then reopened from s2.
    it('opens a resumed run that kept the settled id', async () => {
      getSession.mockImplementation(async id => (id === 's1' ? running('x') : sessionFor(id)));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        emit({ type: 'done', sessionId: 's1', messageId: 'x', content: '' });
        emit({ type: 'start', sessionId: 's1', messageId: 'x' });
      });
      await act(async () => root.render(<Harness id="s2" />));
      const before = readsOf('s1');
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.session?.id).toBe('s1');
      expect(conversation.messages[0]).toEqual(prompt);
      expect(conversation.streaming).toBe(true);
      expect(readsOf('s1') - before).toBe(1);
    });

    it('stops re-reading and opens the chat when the live copy keeps naming a settled reply', async () => {
      getSession.mockImplementation(async id => (id === 's1' ? running('x') : sessionFor(id)));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'error', sessionId: 's1', messageId: 'x', message: 'boom' }));
      await act(async () => root.render(<Harness id="s2" />));
      const before = readsOf('s1');
      await act(async () => root.render(<Harness id="s1" />));
      expect(conversation.session?.id).toBe('s1');
      expect(conversation.messages[0]).toEqual(prompt);
      expect(conversation.streaming).toBe(true);
      expect(conversation.turn?.startedAt).toBe(10);
      expect(readsOf('s1') - before).toBe(4);
    });

    it('reads once more when the reply settles while the opening read is in flight', async () => {
      let answerFirst: (session: ChatSession) => void = () => {};
      getSession.mockImplementationOnce(() => new Promise<ChatSession>(done => (answerFirst = done)));
      getSession.mockResolvedValue(sessionFor('s1', { messages: [prompt] }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'done', sessionId: 's1', messageId: 'x', content: '' }));
      await act(async () => answerFirst(running('x')));
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(conversation.session?.id).toBe('s1');
      expect(conversation.streaming).toBe(false);
      expect(conversation.turn).toBeNull();
    });
  });

  // getSession hands back the cursor its snapshot reflects; what lands while it is in flight is
  // held and applied after it only when the snapshot does not already hold it.
  describe('a stream event landing while the chat is being read', () => {
    let emit: (event: ChatStreamEvent) => void = () => {};
    let answer: (session: ChatSession) => void = () => {};
    const prompt = { id: 'p', role: 'user', content: 'hi', createdAt: at } as const;
    const reply = (content: string) => ({ id: 'r', role: 'assistant', content, createdAt: at }) as const;
    const delta = (seq: number, text: string): ChatStreamEvent => ({
      type: 'delta',
      sessionId: 's1',
      messageId: 'r',
      text,
      seq,
    });
    // A non-live event folds the queued live ones at once rather than on the next frame.
    const flush = (seq: number): ChatStreamEvent => ({
      type: 'phase',
      sessionId: 's1',
      messageId: 'r',
      phase: { kind: 'responding' },
      seq,
    });
    const midTurn = (seq: number) =>
      sessionFor('s1', {
        messages: [prompt, reply('Hi ')],
        replyInFlight: { messageId: 'r', startedAt: 10 },
        eventCursor: { epoch: 'e', seq },
      });

    beforeEach(() => {
      chatStubs().onStreamEvent = listener => {
        emit = listener;
        return () => {};
      };
      getSession.mockImplementation(id =>
        id === 's1' ? new Promise<ChatSession>(done => (answer = done)) : Promise.resolve(sessionFor(id))
      );
    });

    it('applies one after the cursor exactly once and drops one the snapshot holds', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        emit(delta(3, 'Hi '));
        emit(delta(4, 'there'));
      });
      expect(conversation.messages).toEqual([]);
      await act(async () => answer(midTurn(3)));
      await act(async () => emit(flush(5)));
      expect(conversation.messages.at(-1)?.content).toBe('Hi there');

      // Anything at or below the cursor stays dropped after the read too.
      await act(async () => {
        emit(delta(2, 'stale '));
        emit(delta(6, '!'));
        emit(flush(7));
      });
      expect(conversation.messages.at(-1)?.content).toBe('Hi there!');
      expect(getSession).toHaveBeenCalledTimes(1);
    });

    it('ends the turn with a done that lands after the cursor, without reading again', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'done', sessionId: 's1', messageId: 'r', content: 'Hi all', seq: 4 }));
      await act(async () => answer(midTurn(3)));
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(conversation.streaming).toBe(false);
      expect(conversation.turn).toBeNull();
      expect(conversation.messages.map(message => message.content)).toEqual(['hi', 'Hi all']);
    });

    it('drops a done the snapshot already holds', async () => {
      const settled = sessionFor('s1', { messages: [prompt, reply('Hi all')], eventCursor: { epoch: 'e', seq: 4 } });
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'done', sessionId: 's1', messageId: 'r', content: 'Hi all', seq: 4 }));
      await act(async () => answer(settled));
      expect(conversation.messages.map(message => message.content)).toEqual(['hi', 'Hi all']);
      expect(conversation.streaming).toBe(false);
    });

    it('still shows a notice the snapshot reflects, since the snapshot does not carry notices', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () =>
        emit({ type: 'context-notice', sessionId: 's1', kind: 'run-budget', message: 'budget 80%', seq: 2 })
      );
      await act(async () => answer(midTurn(3)));
      expect(conversation.notice).toBe('budget 80%');
      expect(conversation.messages.at(-1)?.content).toBe('Hi ');
    });

    it('clears a notice that a reflected clear removed', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () =>
        emit({ type: 'context-notice', sessionId: 's1', kind: 'run-budget', message: 'budget 80%', seq: 1 })
      );
      await act(async () => emit({ type: 'context-notice-cleared', sessionId: 's1', kind: 'run-budget', seq: 2 }));
      await act(async () => answer(midTurn(3)));
      expect(conversation.notice).toBeNull();
    });

    // Notices come from session/contextNotice, which nothing holds back for the read.
    it('shows a notice at once, while the read is still in flight, and keeps it when the read fails', async () => {
      let fail: (error: Error) => void = () => {};
      getSession.mockImplementation(id =>
        id === 's1' ? new Promise<ChatSession>((_, reject) => (fail = reject)) : Promise.resolve(sessionFor(id))
      );
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () =>
        emit({ type: 'context-notice', sessionId: 's1', kind: 'run-budget', message: 'budget 80%', seq: 1 })
      );
      expect(conversation.notice).toBe('budget 80%');
      await act(async () => fail(new Error('database locked')));
      expect(conversation.notice).toBe('budget 80%');
    });

    it('applies what it held when the read finds no chat', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () =>
        emit({ type: 'context-notice', sessionId: 's1', kind: 'run-budget', message: 'budget 80%', seq: 1 })
      );
      await act(async () => answer(null as unknown as ChatSession));
      expect(conversation.notice).toBe('budget 80%');
    });

    it('drops the read of a chat that is left before it lands', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'done', sessionId: 's1', messageId: 'r', content: 'x', seq: 4 }));
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => answer(midTurn(3)));
      expect(conversation.messages).toEqual([]);
    });

    it('does not read again when the window unmounts mid-read', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'done', sessionId: 's1', messageId: 'r', content: 'x', seq: 4 }));
      await act(async () => root.unmount());
      await act(async () => answer(midTurn(3)));
      expect(getSession).toHaveBeenCalledTimes(1);
    });

    it('leaves events of another chat alone', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => emit({ type: 'context-notice', sessionId: 's2', message: 'notice for s2', seq: 1 }));
      await act(async () => answer(midTurn(3)));
      await act(async () => root.render(<Harness id="s2" />));
      expect(conversation.notice).toBe('notice for s2');
    });

    it('opens a chat with no turn in flight and follows the next one', async () => {
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => answer(sessionFor('s1', { messages: [prompt], eventCursor: { epoch: 'e', seq: 0 } })));
      expect(conversation.messages).toEqual([prompt]);
      expect(conversation.streaming).toBe(false);
      await act(async () => emit({ type: 'start', sessionId: 's1', messageId: 'r', seq: 1 }));
      expect(conversation.streaming).toBe(true);
      expect(conversation.messages.map(message => message.id)).toEqual(['p', 'r']);
    });
  });
});

describe('per-chat setters', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const sessionFor = (id: string): ChatSession => ({
    id,
    title: `Chat ${id}`,
    model: 'local:',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    messages: [],
  });
  const summaryFor = (id: string, patch: Partial<ChatSessionSummary>): ChatSessionSummary => {
    const { messages, ...rest } = sessionFor(id);
    return { ...rest, messageCount: messages.length, ...patch } as ChatSessionSummary;
  };

  type Save = (id: string) => Promise<ChatSessionSummary | null>;
  const saves: Record<string, ReturnType<typeof vi.fn<Save>>> = {};
  const cases: {
    name: string;
    save: string;
    call: (c: ConversationController) => Promise<void>;
    patch: Partial<ChatSessionSummary>;
    read: (c: ConversationController) => unknown;
    stale: unknown;
  }[] = [
    {
      name: 'setReasoningEffort',
      save: 'setSessionReasoningEffort',
      call: c => c.setReasoningEffort('high'),
      patch: { reasoningEffort: 'high' },
      read: c => c.session?.reasoningEffort,
      stale: 'default',
    },
    {
      name: 'setPromptCacheTtl',
      save: 'setSessionPromptCacheTtl',
      call: c => c.setPromptCacheTtl('1h'),
      patch: { promptCacheTtl: '1h' },
      read: c => c.session?.promptCacheTtl,
      stale: undefined,
    },
    {
      name: 'setApprovalMode',
      save: 'setApprovalMode',
      call: c => c.setApprovalMode('auto'),
      patch: { approvalMode: 'auto' },
      read: c => c.session?.approvalMode,
      stale: 'ask',
    },
    {
      name: 'setModel',
      save: 'setSessionModel',
      call: c => c.setModel('other:model'),
      patch: { model: 'other:model' },
      read: c => c.session?.model,
      stale: 'local:',
    },
    {
      name: 'rename',
      save: 'renameSession',
      call: c => c.rename('Renamed'),
      patch: { title: 'Renamed' },
      read: c => c.session?.title,
      stale: 'Chat s2',
    },
  ];

  const extras = { setSessionHistory: vi.fn(), settleLocalModel: vi.fn(), setSessionOrchestrate: vi.fn() };
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;
  const onSummaryChanged = vi.fn();

  function Harness({ id }: { id: string }) {
    conversation = useConversation(id, onSummaryChanged);
    return null;
  }

  /**
   * Starts a save in s1, moves to s2 and back, and lands the save while s1's first read is still out.
   * That read answers with s1 as it was before the save; any later read answers with `saved`.
   */
  async function landSaveDuringReopen(
    start: () => Promise<unknown>,
    land: () => void,
    saved: Partial<ChatSession>
  ): Promise<{ reads: number }> {
    await act(async () => root.render(<Harness id="s1" />));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = start();
    });
    await act(async () => root.render(<Harness id="s2" />));
    const before = sessionFor('s1');
    let answerFirstRead: (session: ChatSession) => void = () => {};
    const counted = { reads: 0 };
    chatStubs().getSession = async (id: string) => {
      if (id !== 's1') return sessionFor(id);
      counted.reads++;
      return counted.reads === 1
        ? new Promise<ChatSession>(done => (answerFirstRead = done))
        : { ...before, ...saved, id: 's1' };
    };
    await act(async () => root.render(<Harness id="s1" />));
    expect(conversation.session?.id).toBe('s2');
    await act(async () => {
      land();
      await pending;
    });
    await act(async () => answerFirstRead(before));
    expect(conversation.session?.id).toBe('s1');
    return counted;
  }

  beforeEach(() => {
    onSummaryChanged.mockReset();
    extras.setSessionHistory.mockReset();
    extras.settleLocalModel.mockReset();
    extras.setSessionOrchestrate.mockReset();
    const chat: Record<string, unknown> = {
      getSession: async (id: string) => sessionFor(id),
      getQueuedMessages: async () => [],
      onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
      onQueueChanged: () => () => {},
      onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
      setSessionHistory: extras.setSessionHistory,
      settleLocalModel: extras.settleLocalModel,
      setSessionOrchestrate: extras.setSessionOrchestrate,
    };
    for (const entry of cases) {
      saves[entry.save] = vi.fn<Save>();
      chat[entry.save] = saves[entry.save];
    }
    Object.assign(window, {
      b4m: { host: chatBackedHostBridge(), chat, claudeImport: { onSessionsChanged: () => () => {} } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe.each(cases)('$name', entry => {
    it('does not paint a save that lands after the chat was switched', async () => {
      let resolve: (summary: ChatSessionSummary) => void = () => {};
      saves[entry.save].mockReturnValue(new Promise(done => (resolve = done)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = entry.call(conversation);
      });
      await act(async () => root.render(<Harness id="s2" />));
      expect(conversation.session?.id).toBe('s2');

      await act(async () => {
        resolve(summaryFor('s1', entry.patch));
        await pending;
      });

      expect(conversation.session?.id).toBe('s2');
      expect(entry.read(conversation)).toBe(entry.stale);
      expect(onSummaryChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', ...entry.patch }));
    });

    it('shows no notice for a save that is rejected after the chat was switched', async () => {
      let reject: (error: Error) => void = () => {};
      saves[entry.save].mockReturnValue(new Promise((_, fail) => (reject = fail)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = entry.call(conversation);
      });
      await act(async () => root.render(<Harness id="s2" />));

      await act(async () => {
        reject(new Error('disk full'));
        await pending;
      });

      expect(conversation.notice).toBeNull();
    });

    it('applies a save that lands while its chat is still open', async () => {
      saves[entry.save].mockImplementation(async id => summaryFor(id, entry.patch));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => entry.call(conversation));
      expect(entry.read(conversation)).toBe(Object.values(entry.patch)[0]);
    });

    it('reads the chat again when its save lands while the chat is being reopened', async () => {
      let resolve: (summary: ChatSessionSummary) => void = () => {};
      saves[entry.save].mockReturnValue(new Promise(done => (resolve = done)));
      const { reads } = await landSaveDuringReopen(
        () => entry.call(conversation),
        () => resolve(summaryFor('s1', entry.patch)),
        entry.patch as Partial<ChatSession>
      );
      expect(reads).toBe(2);
      expect(entry.read(conversation)).toBe(Object.values(entry.patch)[0]);
    });

    it('reports a rejected save as a notice instead of throwing', async () => {
      saves[entry.save].mockRejectedValue(new Error('disk full'));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        await expect(entry.call(conversation)).resolves.toBeUndefined();
      });
      expect(conversation.notice).toContain('disk full');
    });
  });

  describe('setModel notice', () => {
    it('clears a notice left by an earlier rejected save', async () => {
      saves.setSessionReasoningEffort.mockRejectedValue(new Error('disk full'));
      saves.setSessionModel.mockImplementation(async id => summaryFor(id, { model: 'other:model' }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => conversation.setReasoningEffort('high'));
      expect(conversation.notice).toContain('disk full');

      await act(async () => conversation.setModel('other:model'));

      expect(conversation.notice).toBeNull();
    });

    it('leaves the open chat notice alone when the save was for another chat', async () => {
      let resolve: (summary: ChatSessionSummary) => void = () => {};
      saves.setSessionModel.mockReturnValue(new Promise(done => (resolve = done)));
      saves.setSessionReasoningEffort.mockRejectedValue(new Error('disk full'));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = conversation.setModel('other:model');
      });
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => conversation.setReasoningEffort('high'));
      expect(conversation.notice).toContain('disk full');

      await act(async () => {
        resolve(summaryFor('s1', { model: 'other:model' }));
        await pending;
      });

      expect(conversation.notice).toContain('disk full');
    });
  });

  describe.each([
    { name: 'setHistory', fn: 'setSessionHistory', call: (c: ConversationController) => c.setHistory(true) },
    { name: 'settleLocalModel', fn: 'settleLocalModel', call: (c: ConversationController) => c.settleLocalModel() },
  ] as const)('$name rejection', entry => {
    it('reports a rejection as a notice instead of throwing', async () => {
      extras[entry.fn].mockRejectedValue(new Error('disk full'));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        await expect(entry.call(conversation)).resolves.toBeUndefined();
      });
      expect(conversation.notice).toContain('disk full');
    });

    it('shows no notice for a rejection after the chat was switched', async () => {
      let reject: (error: Error) => void = () => {};
      extras[entry.fn].mockReturnValue(new Promise((_, fail) => (reject = fail)));
      await act(async () => root.render(<Harness id="s1" />));
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = entry.call(conversation);
      });
      await act(async () => root.render(<Harness id="s2" />));

      await act(async () => {
        reject(new Error('disk full'));
        await pending;
      });

      expect(conversation.notice).toBeNull();
    });
  });

  describe.each([
    {
      name: 'setHistory',
      fn: 'setSessionHistory',
      call: (c: ConversationController) => c.setHistory(true),
      answer: summaryFor('s1', { historyEnabled: true }),
      saved: { historyEnabled: true },
      read: (c: ConversationController) => c.session?.historyEnabled,
    },
    {
      name: 'settleLocalModel',
      fn: 'settleLocalModel',
      call: (c: ConversationController) => c.settleLocalModel(),
      answer: { session: summaryFor('s1', { model: 'local:ollama:qwen3:8b' }) },
      saved: { model: 'local:ollama:qwen3:8b' },
      read: (c: ConversationController) => c.session?.model,
    },
    {
      name: 'setOrchestrate',
      fn: 'setSessionOrchestrate',
      call: (c: ConversationController) => c.setOrchestrate(true),
      answer: summaryFor('s1', { orchestrate: true }),
      saved: { orchestrate: true },
      read: (c: ConversationController) => c.session?.orchestrate,
    },
  ] as const)('$name during a reopen', entry => {
    it('reads the chat again when its write lands while the chat is being reopened', async () => {
      let resolve: (answer: unknown) => void = () => {};
      extras[entry.fn].mockReturnValue(new Promise(done => (resolve = done)));
      const { reads } = await landSaveDuringReopen(
        () => entry.call(conversation),
        () => resolve(entry.answer),
        entry.saved
      );
      expect(reads).toBe(2);
      expect(entry.read(conversation)).toBe(Object.values(entry.saved)[0]);
    });
  });
});

describe('generation settings', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const session: ChatSession = {
    id: 's1',
    title: 'Chat',
    model: 'local:ollama:qwen3:8b',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    generation: { temperature: 0.4 },
    createdAt: at,
    updatedAt: at,
    messages: [],
  };
  const setSessionGeneration = vi.fn(
    async (_id: string, generation: GenerationSettings): Promise<ChatSessionSummary> => {
      const { messages: _messages, ...meta } = session;
      const { generation: _old, ...rest } = meta;
      return { ...rest, ...(Object.keys(generation).length > 0 ? { generation } : {}), messageCount: 0 };
    }
  );
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;

  function Harness({ id = 's1' }: { id?: string }) {
    conversation = useConversation(id, () => {});
    return null;
  }

  beforeEach(() => {
    setSessionGeneration.mockClear();
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession: async () => session,
          setSessionGeneration,
          getQueuedMessages: async () => [],
          onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
          onQueueChanged: () => () => {},
          onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
        },
        claudeImport: { onSessionsChanged: () => () => {} },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe('a conversation generation settings', () => {
    it('reopens with the stored overrides, and saves and clears them through main', async () => {
      await act(async () => root.render(<Harness />));
      expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

      await act(async () => conversation.setGeneration({ temperature: 0.4, topK: 20 }));
      expect(setSessionGeneration).toHaveBeenLastCalledWith('s1', { temperature: 0.4, topK: 20 });
      expect(conversation.session?.generation).toEqual({ temperature: 0.4, topK: 20 });

      await act(async () => conversation.setGeneration({}));
      expect(conversation.session?.generation).toBeUndefined();
    });

    it('says so when main does not save them, and keeps what was shown', async () => {
      await act(async () => root.render(<Harness />));
      setSessionGeneration.mockRejectedValueOnce(new Error('disk full'));
      let saved: boolean | undefined;
      await act(async () => {
        saved = await conversation.setGeneration({ topK: 20 });
      });
      expect(saved).toBe(false);
      expect(conversation.notice).toBe("Could not save this chat's params. disk full");
      expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

      setSessionGeneration.mockResolvedValueOnce(null as unknown as ChatSessionSummary);
      await act(async () => {
        saved = await conversation.setGeneration({ topK: 30 });
      });
      expect(saved).toBe(false);
      expect(conversation.notice).toBe("Could not save this chat's params. The conversation could not be found.");
      expect(conversation.session?.generation).toEqual({ temperature: 0.4 });
    });

    it('applies only the latest of two saves, whichever answers last', async () => {
      await act(async () => root.render(<Harness />));
      let answerFirst: (summary: ChatSessionSummary) => void = () => {};
      const { messages: _messages, generation: _generation, ...meta } = session;
      setSessionGeneration.mockImplementationOnce(
        () => new Promise<ChatSessionSummary>(resolve => (answerFirst = resolve))
      );
      let first: Promise<boolean> | undefined;
      await act(async () => {
        first = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => conversation.setGeneration({ topK: 30 }));
      await act(async () => {
        answerFirst({ ...meta, generation: { topK: 20 }, messageCount: 0 });
        await first;
      });
      expect(conversation.session?.generation).toEqual({ topK: 30 });
    });

    it('says nothing when an older save fails after a newer one landed', async () => {
      await act(async () => root.render(<Harness />));
      let failFirst: (error: Error) => void = () => {};
      setSessionGeneration.mockImplementationOnce(
        () => new Promise<ChatSessionSummary>((_resolve, reject) => (failFirst = reject))
      );
      let first: Promise<boolean> | undefined;
      await act(async () => {
        first = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => conversation.setGeneration({ topK: 30 }));
      await act(async () => {
        failFirst(new Error('disk full'));
        await first;
      });
      expect(conversation.notice).toBeNull();
      expect(conversation.session?.generation).toEqual({ topK: 30 });
    });

    it('shows what main holds when the newest save fails after an older one landed unseen', async () => {
      await act(async () => root.render(<Harness />));
      let answerFirst: (summary: ChatSessionSummary) => void = () => {};
      let failSecond: (error: Error) => void = () => {};
      setSessionGeneration
        .mockImplementationOnce(() => new Promise<ChatSessionSummary>(resolve => (answerFirst = resolve)))
        .mockImplementationOnce(() => new Promise<ChatSessionSummary>((_resolve, reject) => (failSecond = reject)));
      let first: Promise<boolean> | undefined;
      let second: Promise<boolean> | undefined;
      await act(async () => {
        first = conversation.setGeneration({ topK: 20 });
        second = conversation.setGeneration({ topK: 30 });
      });
      const { messages: _messages, generation: _generation, ...meta } = session;
      await act(async () => {
        answerFirst({ ...meta, generation: { topK: 20 }, messageCount: 0 });
        await first;
      });
      expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

      chatStubs().getSession = async () => ({ ...session, generation: { topK: 20 } });
      let saved: boolean | undefined;
      await act(async () => {
        failSecond(new Error('disk full'));
        saved = await second;
      });
      expect(saved).toBe(false);
      expect(conversation.notice).toBe("Could not save this chat's params. disk full");
      expect(conversation.session?.generation).toEqual({ topK: 20 });
    });

    it('does not put a save that lands after a switch on the conversation now open', async () => {
      const other: ChatSession = { ...session, id: 's2', generation: { topP: 0.5 } };
      chatStubs().getSession = async (id: string) => (id === 's2' ? other : session);
      await act(async () => root.render(<Harness />));
      let answer: (summary: ChatSessionSummary) => void = () => {};
      setSessionGeneration.mockImplementationOnce(() => new Promise<ChatSessionSummary>(resolve => (answer = resolve)));
      let save: Promise<boolean> | undefined;
      await act(async () => {
        save = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => root.render(<Harness id="s2" />));
      const { messages: _messages, generation: _generation, ...meta } = session;
      await act(async () => {
        answer({ ...meta, generation: { topK: 20 }, messageCount: 0 });
        await save;
      });
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.session?.generation).toEqual({ topP: 0.5 });
    });

    it('keeps an older set main sends back from replacing a newer save that landed while it was read', async () => {
      await act(async () => root.render(<Harness />));
      let failFirst: (error: Error) => void = () => {};
      let read: (value: ChatSession) => void = () => {};
      setSessionGeneration.mockImplementationOnce(
        () => new Promise<ChatSessionSummary>((_resolve, reject) => (failFirst = reject))
      );
      chatStubs().getSession = () => new Promise<ChatSession>(resolve => (read = resolve));
      let first: Promise<boolean> | undefined;
      await act(async () => {
        first = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => failFirst(new Error('disk full')));
      await act(async () => conversation.setGeneration({ topK: 30 }));
      expect(conversation.session?.generation).toEqual({ topK: 30 });
      await act(async () => {
        read(session);
        await first;
      });
      expect(conversation.session?.generation).toEqual({ topK: 30 });
    });

    describe('across chats', () => {
      const { messages: _messages, generation: _generation, ...meta } = session;

      it('shows a save that lands while its chat is being reopened, whose first read predates it', async () => {
        const other: ChatSession = { ...session, id: 's2', generation: { topP: 0.5 } };
        chatStubs().getSession = async (id: string) => (id === 's2' ? other : session);
        await act(async () => root.render(<Harness />));
        let answer: (summary: ChatSessionSummary) => void = () => {};
        setSessionGeneration.mockImplementationOnce(
          () => new Promise<ChatSessionSummary>(resolve => (answer = resolve))
        );
        let save: Promise<boolean> | undefined;
        await act(async () => {
          save = conversation.setGeneration({ topK: 20 });
        });
        await act(async () => root.render(<Harness id="s2" />));
        let answerFirstRead: (value: ChatSession) => void = () => {};
        let reads = 0;
        chatStubs().getSession = async (id: string) => {
          if (id === 's2') return other;
          reads++;
          return reads === 1
            ? new Promise<ChatSession>(resolve => (answerFirstRead = resolve))
            : { ...session, generation: { topK: 20 } };
        };
        await act(async () => root.render(<Harness id="s1" />));
        await act(async () => {
          answer({ ...meta, generation: { topK: 20 }, messageCount: 0 });
          await save;
        });
        await act(async () => answerFirstRead(session));
        expect(reads).toBe(2);
        expect(conversation.session?.id).toBe('s1');
        expect(conversation.session?.generation).toEqual({ topK: 20 });
      });

      it('tells only the chat it failed in, and leaves the open one as it was', async () => {
        const other: ChatSession = { ...session, id: 's2', generation: { topP: 0.5 } };
        chatStubs().getSession = async (id: string) => (id === 's2' ? other : session);
        await act(async () => root.render(<Harness />));
        let fail: (error: Error) => void = () => {};
        setSessionGeneration.mockImplementationOnce(
          () => new Promise<ChatSessionSummary>((_resolve, reject) => (fail = reject))
        );
        let save: Promise<boolean> | undefined;
        await act(async () => {
          save = conversation.setGeneration({ topK: 20 });
        });
        await act(async () => root.render(<Harness id="s2" />));
        await act(async () => {
          fail(new Error('disk full'));
          await save;
        });
        expect(conversation.session?.id).toBe('s2');
        expect(conversation.notice).toBeNull();
        expect(conversation.session?.generation).toEqual({ topP: 0.5 });
      });

      it("applies a chat's save that lands after a save in another chat", async () => {
        const other: ChatSession = { ...session, id: 's2', generation: undefined };
        chatStubs().getSession = async (id: string) => (id === 's2' ? other : session);
        await act(async () => root.render(<Harness />));
        let answer: (summary: ChatSessionSummary) => void = () => {};
        setSessionGeneration.mockImplementationOnce(
          () => new Promise<ChatSessionSummary>(resolve => (answer = resolve))
        );
        let save: Promise<boolean> | undefined;
        await act(async () => {
          save = conversation.setGeneration({ topK: 20 });
        });
        await act(async () => root.render(<Harness id="s2" />));
        await act(async () => conversation.setGeneration({ topP: 0.7 }));
        await act(async () => root.render(<Harness id="s1" />));
        await act(async () => {
          answer({ ...meta, generation: { topK: 20 }, messageCount: 0 });
          await save;
        });
        expect(conversation.session?.id).toBe('s1');
        expect(conversation.session?.generation).toEqual({ topK: 20 });
      });

      it("reports a chat's failed save once it is open again, after a save in another chat", async () => {
        const other: ChatSession = { ...session, id: 's2', generation: undefined };
        chatStubs().getSession = async (id: string) => (id === 's2' ? other : session);
        await act(async () => root.render(<Harness />));
        let fail: (error: Error) => void = () => {};
        setSessionGeneration.mockImplementationOnce(
          () => new Promise<ChatSessionSummary>((_resolve, reject) => (fail = reject))
        );
        let save: Promise<boolean> | undefined;
        await act(async () => {
          save = conversation.setGeneration({ topK: 20 });
        });
        await act(async () => root.render(<Harness id="s2" />));
        await act(async () => conversation.setGeneration({ topP: 0.7 }));
        await act(async () => root.render(<Harness id="s1" />));
        await act(async () => {
          fail(new Error('disk full'));
          await save;
        });
        expect(conversation.session?.id).toBe('s1');
        expect(conversation.notice).toBe("Could not save this chat's params. disk full");
        expect(conversation.session?.generation).toEqual({ temperature: 0.4 });
      });
    });

    it('saves nothing before the conversation has loaded', async () => {
      let finish: (value: ChatSession) => void = () => {};
      chatStubs().getSession = () => new Promise<ChatSession>(resolve => (finish = resolve));
      await act(async () => root.render(<Harness />));
      expect(await conversation.setGeneration({ topK: 20 })).toBe(false);
      expect(setSessionGeneration).not.toHaveBeenCalled();
      await act(async () => finish(session));
    });
  });
});

describe('imported transcripts and history consent', () => {
  const at = '2026-10-01T00:00:00.000Z';
  function imported(content: string): ChatSession {
    return {
      id: 'cc-import',
      title: 'Imported',
      model: 'm',
      mode: 'chat',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      createdAt: at,
      updatedAt: at,
      importOrigin: { kind: 'claude-code', sourceId: 'import', importedAt: at, sourceUpdatedAt: at },
      messages: [{ id: 'cc-u', role: 'user', content, createdAt: at }],
    };
  }
  const changed = new Set<() => void>();
  const summaries = new Set<(summary: ChatSessionSummary) => void>();
  const streamed = new Set<(event: ChatStreamEvent) => void>();
  const setSessionHistory = vi.fn();
  const getSession = vi.fn<(id: string) => Promise<ChatSession | null>>();
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;
  function Harness({ id }: { id: string | null }) {
    conversation = useConversation(id, () => {});
    return <div>{conversation.messages.map(message => message.content).join(',')}</div>;
  }
  async function show(id = 'cc-import') {
    await act(async () => root.render(<Harness id={id} />));
  }
  async function push() {
    await act(async () => {
      for (const listener of changed) listener();
    });
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }
  beforeEach(() => {
    changed.clear();
    streamed.clear();
    summaries.clear();
    getSession.mockReset();
    setSessionHistory.mockReset();
    getSession.mockResolvedValue(imported('old'));
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession,
          setSessionHistory,
          getQueuedMessages: async () => [],
          onSessionSummary: (listener: (summary: ChatSessionSummary) => void) => {
            summaries.add(listener);
            return () => summaries.delete(listener);
          },
          onQueueChanged: () => () => {},
          onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
            streamed.add(listener);
            return () => streamed.delete(listener);
          },
        },
        claudeImport: {
          onSessionsChanged: (listener: () => void) => {
            changed.add(listener);
            return () => changed.delete(listener);
          },
        },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  describe('open imported transcripts', () => {
    it('does not restore preparation from a read overtaken by workspace completion', async () => {
      const pending = deferred<ChatSession | null>();
      getSession.mockReturnValueOnce(pending.promise);
      await show();

      await act(async () => {
        for (const listener of streamed) {
          listener({ type: 'workspace', sessionId: 'cc-import', running: false, base: 'main' });
        }
        pending.resolve({ ...imported('old'), preparingWorkspace: { since: 1, base: 'main' } });
      });

      expect(conversation.preparing).toBeNull();
      expect(getSession).toHaveBeenCalledTimes(2);
    });

    it('refreshes after source sync without replacing the user-selected model', async () => {
      await show();
      getSession.mockResolvedValue({
        ...imported('synced'),
        model: 'other',
        title: 'New source title',
        importOrigin: { ...imported('').importOrigin!, sourceUpdatedAt: '2026-10-02T00:00:00.000Z' },
      });
      await push();
      expect(host.textContent).toBe('synced');
      expect(conversation.session?.model).toBe('m');
      expect(conversation.session?.title).toBe('New source title');
      expect(conversation.session?.importOrigin?.sourceUpdatedAt).toBe('2026-10-02T00:00:00.000Z');
    });
    it('does not re-read ordinary conversations or continued imports', async () => {
      getSession.mockResolvedValue({ ...imported('own'), importOrigin: undefined });
      await show();
      await push();
      expect(getSession).toHaveBeenCalledTimes(1);
      getSession.mockResolvedValue({
        ...imported('continued'),
        importOrigin: { ...imported('').importOrigin!, forkedAt: at },
      });
      await show('cc-other');
      await push();
      expect(getSession).toHaveBeenCalledTimes(2);
    });
    it('ignores an older read that finishes after a newer sync', async () => {
      await show();
      const old = deferred<ChatSession | null>();
      getSession.mockReturnValueOnce(old.promise);
      await push();
      getSession.mockResolvedValue(imported('newest'));
      await push();
      await act(async () => old.resolve(imported('stale')));
      expect(host.textContent).toBe('newest');
    });
    it('does not replace a reply that starts while refresh is in flight', async () => {
      await show();
      const pending = deferred<ChatSession | null>();
      getSession.mockReturnValueOnce(pending.promise);
      await push();
      await act(async () => {
        for (const listener of streamed) listener({ type: 'start', sessionId: 'cc-import', messageId: 'own-reply' });
      });
      await act(async () => pending.resolve(imported('stale')));
      expect(host.textContent).toBe('old,');
      expect(conversation.streaming).toBe(true);
      expect(conversation.messages.at(-1)?.id).toBe('own-reply');
    });
    it('ignores a refresh that resolves after selecting another conversation', async () => {
      await show();
      const pending = deferred<ChatSession | null>();
      getSession.mockReturnValueOnce(pending.promise);
      await push();
      getSession.mockResolvedValue({ ...imported('another'), id: 'other' });
      await show('other');
      await act(async () => pending.resolve(imported('stale')));
      expect(host.textContent).toBe('another');
    });
    it('reports a failed refresh and keeps the last transcript', async () => {
      await show();
      getSession.mockRejectedValue(new Error('disk unavailable'));
      await push();
      expect(host.textContent).toBe('old');
      expect(conversation.sendError).toContain('disk unavailable');
    });
  });

  it('reports a failed history toggle without an unhandled rejection', async () => {
    await show();
    setSessionHistory.mockRejectedValue(new Error('Index unavailable'));
    await act(async () => {
      await conversation.setHistory(true);
    });
    expect(conversation.notice).toContain('Index unavailable');
    expect(conversation.session?.historyEnabled).not.toBe(true);
  });

  it('does not apply a history toggle response to a different conversation', async () => {
    await show();
    const pending = deferred<ChatSession>();
    setSessionHistory.mockReturnValue(pending.promise);
    let toggle!: Promise<void>;
    await act(async () => {
      toggle = conversation.setHistory(true);
    });
    getSession.mockResolvedValue({ ...imported('other'), id: 'other' });
    await show('other');
    await act(async () => {
      pending.resolve({ ...imported('old'), historyEnabled: true });
      await toggle;
    });
    expect(conversation.session?.id).toBe('other');
    expect(conversation.session?.historyEnabled).not.toBe(true);
  });

  it('keeps newer consent pushed by another window when an older toggle response arrives', async () => {
    await show();
    const pending = deferred<ChatSession>();
    setSessionHistory.mockReturnValue(pending.promise);
    let toggle!: Promise<void>;
    await act(async () => {
      toggle = conversation.setHistory(true);
    });
    const { messages: _messages, ...summary } = imported('old');
    await act(async () => {
      for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: false });
      pending.resolve({ ...imported('old'), historyEnabled: true });
      await toggle;
    });
    expect(conversation.session?.historyEnabled).toBe(false);
  });

  it('does not change consent using the previous conversation while the selected one loads', async () => {
    await show();
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValue(pending.promise);
    await show('other');
    expect(conversation.session?.id).toBe('cc-import');
    await act(async () => conversation.setHistory(true));
    expect(setSessionHistory).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ ...imported('other'), id: 'other' }));
  });

  it('applies history consent updates pushed by another window', async () => {
    await show();
    const { messages: _messages, ...summary } = imported('old');
    for (const enabled of [true, false]) {
      await act(async () => {
        for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: enabled });
      });
      expect(conversation.session?.historyEnabled).toBe(enabled);
    }
  });

  it('re-reads consent when another window changes it during the initial session load', async () => {
    const pending = deferred<ChatSession | null>();
    getSession.mockReturnValueOnce(pending.promise);
    await show();
    const { messages: _messages, ...summary } = imported('old');
    getSession.mockResolvedValue({ ...imported('old'), historyEnabled: true });
    await act(async () => {
      for (const listener of summaries) listener({ ...summary, messageCount: 1, historyEnabled: true });
      pending.resolve(imported('old'));
    });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(conversation.session?.historyEnabled).toBe(true);
  });
});

describe('sending while navigating', () => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  const at = '2026-11-07T00:00:00.000Z';
  const summaryChanged = vi.fn();
  const getSession = vi.fn<(id: string) => Promise<ChatSession | null>>();
  const sendMessage = vi.fn<() => Promise<SendMessageResult>>();
  const loopCommand = vi.fn<() => Promise<LoopResult>>();
  let conversation: ConversationController;
  let stream: (event: ChatStreamEvent) => void;
  let container: HTMLDivElement;
  let root: Root;

  function session(id: string): ChatSession {
    return {
      id,
      title: id,
      model: 'm',
      mode: 'chat',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      createdAt: at,
      updatedAt: at,
      messages: [{ id: `${id}-prompt`, role: 'user', content: `History of ${id}`, createdAt: at }],
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function Harness({ id }: { id: string }) {
    conversation = useConversation(id, summaryChanged);
    // ChatShell hides the thread until the loaded session matches the selected conversation.
    if (conversation.session?.id !== id) return <div data-testid="chat-thread-opening" />;
    return (
      <MessageThread
        key={id}
        messages={conversation.messages}
        sessionId={id}
        streaming={conversation.streaming}
        onRespond={() => undefined}
        onContinue={() => undefined}
      />
    );
  }

  async function show(id: string) {
    await act(async () => {
      root.render(
        <CssVarsProvider>
          <Harness id={id} />
        </CssVarsProvider>
      );
    });
  }

  function expectHistory(id: string) {
    expect(container.querySelector('[data-testid="chat-thread-opening"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-user"]')?.textContent).toContain(`History of ${id}`);
    expect(conversation.session?.id).toBe(id);
  }

  beforeEach(() => {
    getSession.mockReset().mockImplementation(async id => session(id));
    sendMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'reply' });
    loopCommand.mockReset();
    summaryChanged.mockReset();
    Element.prototype.scrollIntoView = () => undefined;
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession,
          sendMessage,
          loopCommand,
          getQueuedMessages: async () => [],
          onSessionSummary: () => () => undefined,
          onQueueChanged: () => () => undefined,
          onStreamEvent: (listener: typeof stream) => {
            stream = listener;
            return () => undefined;
          },
        },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe('sending while navigating between conversations', () => {
    it.each([true, false])('ignores a loop result arriving after navigation (accepted: %s)', async accepted => {
      await show('first');
      const pending = deferred<LoopResult>();
      loopCommand.mockReturnValueOnce(pending.promise);
      let command: Promise<void>;
      await act(async () => {
        command = conversation.runCommand('loop', '30s Check the build');
      });
      await show('second');

      await act(async () => {
        pending.resolve(
          accepted ? { ok: true, state: null, notice: 'Loop started.' } : { ok: false, error: 'Skill unavailable.' }
        );
        await command;
      });

      expectHistory('second');
      expect(conversation.sendError).toBeNull();
      expect(conversation.notice).toBeNull();
    });

    it('keeps the selected history when an earlier send finishes its session read after a stopped approval', async () => {
      await show('first');
      const pending = deferred<ChatSession | null>();
      getSession.mockReturnValueOnce(pending.promise);
      let sent: Promise<boolean>;
      await act(async () => {
        sent = conversation.send('Run a command');
      });
      act(() => {
        stream({ type: 'start', sessionId: 'first', messageId: 'reply' });
        stream({
          type: 'done',
          sessionId: 'first',
          messageId: 'reply',
          content: '',
          stopReason: 'aborted',
          toolCalls: [
            {
              id: 'call',
              name: 'bash',
              input: { command: 'printf test' },
              status: 'denied',
              error: 'Not run: the reply was stopped before this was approved.',
            },
          ],
        });
      });
      await show('second');
      expectHistory('second');

      await act(async () => {
        pending.resolve(session('first'));
        await sent;
      });
      expectHistory('second');
      expect(summaryChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }));

      act(() =>
        stream({
          type: 'message',
          sessionId: 'second',
          message: {
            id: 'relay',
            role: 'user',
            content: 'Follow-up from another session',
            createdAt: at,
            relay: { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 },
          },
        })
      );
      expectHistory('second');
      expect(container.querySelector('[data-testid="chat-message-relay"]')).not.toBeNull();
    });

    it.each([true, false])(
      'ignores a send acknowledgement arriving after navigation (accepted: %s)',
      async accepted => {
        await show('first');
        const pending = deferred<SendMessageResult>();
        sendMessage.mockReturnValueOnce(pending.promise);
        let sent: Promise<boolean>;
        await act(async () => {
          sent = conversation.send('Old prompt');
        });
        await show('second');
        await act(async () => {
          pending.resolve(accepted ? { ok: true, messageId: 'reply' } : { ok: false, error: 'Refused' });
          await sent;
        });
        expectHistory('second');
        expect(conversation.messages).toEqual(session('second').messages);
        expect(conversation.sendError).toBeNull();
        expect(conversation.returned).toBeNull();

        await show('first');
        if (accepted) {
          expect(conversation.returned).toBeNull();
        } else {
          expect(conversation.returned?.messages.map(m => m.text)).toEqual(['Old prompt']);
        }
      }
    );
  });
});

describe('sharing a folder', () => {
  // Off, so React's own scheduler runs: it flushes a render's passive effects a task after the commit, not inside act().
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const NOTES = '/work/notes';
  const at = '2026-10-01T00:00:00.000Z';
  const summary = (grantedDirectories: string[]): ChatSessionSummary =>
    ({
      id: 'fresh',
      title: 'New conversation',
      mode: 'chat',
      model: 'claude-opus-4-5-20251101',
      messageCount: 0,
      createdAt: at,
      updatedAt: at,
      grantedDirectories,
    }) as ChatSessionSummary;
  const session = (grantedDirectories: string[]) =>
    ({ ...summary(grantedDirectories), messages: [] }) as unknown as ChatSession;

  // Untyped under the web tsconfig, which has no Node types.
  const { setImmediate: nextTurn } = globalThis as unknown as { setImmediate: (callback: () => void) => void };

  // React's scheduler runs on setImmediate here, so each turn lets it finish one more task: the render, its passive
  // effects, and the re-render those cause, all well within ten turns.
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) await new Promise<void>(resolve => nextTurn(resolve));
  }

  let conversation: ConversationController;
  let onOpen: (() => void) | null = null;

  function Harness({ sessionId }: { sessionId: string | null }) {
    conversation = useConversation(sessionId, () => undefined);
    useLayoutEffect(() => {
      if (sessionId) onOpen?.();
    }, [sessionId]);
    return null;
  }

  function stubBridge(chat: Record<string, unknown>) {
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: {
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => undefined,
        onQueueChanged: () => () => undefined,
        onStreamEvent: () => () => undefined,
        ...chat,
      },
      claudeImport: { onSessionsChanged: () => () => undefined },
    };
  }

  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    onOpen = null;
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    root.unmount();
    await settle();
    vi.unstubAllGlobals();
  });

  const lateReplies = [
    {
      reply: {
        status: 'added',
        path: NOTES,
        warning: 'This is your home folder.',
        session: summary([NOTES]),
      } as ShareDirectoryResult,
      outcome: { value: `Shared ${NOTES} with this conversation. This is your home folder.` },
    },
    {
      reply: { status: 'refused', error: 'The filesystem root cannot be shared.' } as ShareDirectoryResult,
      outcome: { error: 'The filesystem root cannot be shared.' },
    },
  ];

  describe('sharing a folder into a chat by id', () => {
    it.each(lateReplies)(
      'hands back a $reply.status reply that lands before the opened chat has reset',
      async ({ reply, outcome }) => {
        let answer: (result: ShareDirectoryResult) => void = () => undefined;
        stubBridge({
          getSession: async () => session([]),
          addContextDirectory: () => new Promise<ShareDirectoryResult>(resolve => (answer = resolve)),
        });
        // Main's reply arrives in the commit that opens the chat, ahead of that chat's passive reset.
        onOpen = () => answer(reply);
        root.render(<Harness sessionId={null} />);
        await settle();

        const shared = conversation.addContextDirectoryTo('fresh', NOTES).then(
          value => ({ value }),
          (error: Error) => ({ error: error.message })
        );
        root.render(<Harness sessionId="fresh" />);
        expect(await shared).toEqual(outcome);
        await settle();
        expect(conversation.notice).toBeNull();
        expect(conversation.sendError).toBeNull();
      }
    );

    it.each(lateReplies)(
      'hands back a $reply.status reply that lands after its chat was left, before the next one resets',
      async ({ reply, outcome }) => {
        let answer: (result: ShareDirectoryResult) => void = () => undefined;
        stubBridge({
          getSession: async () => session([]),
          addContextDirectory: () => new Promise<ShareDirectoryResult>(resolve => (answer = resolve)),
        });
        root.render(<Harness sessionId="fresh" />);
        await settle();

        // Main's reply arrives in the commit that opens another chat, while the reset still names this one.
        onOpen = () => answer(reply);
        const shared = conversation.addContextDirectoryTo('fresh', NOTES).then(
          value => ({ value }),
          (error: Error) => ({ error: error.message })
        );
        root.render(<Harness sessionId="other" />);
        expect(await shared).toEqual(outcome);
      }
    );

    it('reads a chat again when a share lands during its read, not laying the older summary over it', async () => {
      let stored = session([]);
      let serveFirstRead: (loaded: ChatSession) => void = () => undefined;
      let reads = 0;
      stubBridge({
        getSession: () =>
          ++reads === 1 ? new Promise<ChatSession>(resolve => (serveFirstRead = resolve)) : Promise.resolve(stored),
        addContextDirectory: async (): Promise<ShareDirectoryResult> => {
          stored = session([NOTES]);
          return { status: 'added', path: NOTES, session: summary([NOTES]) };
        },
      });
      root.render(<Harness sessionId="fresh" />);
      // The read is asked for in a passive effect, which a fixed delay can outrun on a busy runner.
      await vi.waitFor(() => expect(reads).toBe(1), { interval: 5 });

      await conversation.addContextDirectoryTo('fresh', NOTES);
      // Another window takes the folder back before main serves the read that was already asked for.
      stored = session([]);
      serveFirstRead(stored);
      // The session is set only once a read is not stale, so this waits out the read done again.
      await vi.waitFor(() => expect(conversation.session?.grantedDirectories).toEqual([]), { interval: 5 });

      expect(reads).toBe(2);
    });
  });
});

describe('background notices', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const sessionNamed = (id: string): ChatSession => ({
    id,
    title: id,
    model: 'local:',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    messages: [],
  });
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;
  let sessions: SessionsController;
  let listeners: ((event: ChatStreamEvent) => void)[] = [];
  const emit = (event: ChatStreamEvent) => listeners.forEach(listener => listener(event));

  function Harness({ id }: { id: string }) {
    conversation = useConversation(id, () => {});
    sessions = useSessions();
    return null;
  }

  const noticeFor = (sessionId: string): ChatStreamEvent => ({
    type: 'context-notice',
    sessionId,
    message: `notice for ${sessionId}`,
  });

  beforeEach(() => {
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession: async (id: string) => sessionNamed(id),
          listSessions: async () => [],
          deleteSession: vi.fn(async () => undefined),
          getQueuedMessages: async () => [],
          onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
          onQueueChanged: () => () => {},
          onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
            listeners.push(listener);
            return () => {
              listeners = listeners.filter(item => item !== listener);
            };
          },
        },
        claudeImport: { onSessionsChanged: () => () => {} },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe('a context notice for a conversation that is not open', () => {
    it('shows when that conversation opens, once', async () => {
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => emit(noticeFor('away')));
      expect(conversation.notice).toBeNull();

      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBe('notice for away');

      await act(async () => root.render(<Harness id="open" />));
      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBeNull();
    });

    it('keeps every distinct notice that arrived while it was away', async () => {
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => emit({ type: 'context-notice', sessionId: 'away', message: 'no tools' }));
      await act(async () => emit({ type: 'context-notice', sessionId: 'away', message: 'context grew' }));
      await act(async () => emit({ type: 'context-notice', sessionId: 'away', message: 'context grew' }));

      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBe('no tools\ncontext grew');
    });

    it('keeps only the newest notice of each kind', async () => {
      const say = (message: string, kind?: 'context-size' | 'no-tools') =>
        emit({ type: 'context-notice', sessionId: 'away', message, kind });
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => say('size one', 'context-size'));
      await act(async () => say('tools', 'no-tools'));
      await act(async () => say('size two', 'context-size'));

      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBe('size two\ntools');
    });

    it('replaces a notice without a kind only when the text is identical', async () => {
      const say = (message: string) => emit({ type: 'context-notice', sessionId: 'away', message });
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => say('a'));
      await act(async () => say('b'));
      await act(async () => say('a'));

      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBe('a\nb');
    });

    it('withdraws only the cleared kind, whether the conversation is open or away', async () => {
      const budget = (sessionId: string) =>
        emit({ type: 'context-notice', sessionId, message: `budget ${sessionId}`, kind: 'run-budget' });
      const cleared = (sessionId: string) => emit({ type: 'context-notice-cleared', sessionId, kind: 'run-budget' });
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => emit({ type: 'context-notice', sessionId: 'open', message: 'tools', kind: 'no-tools' }));
      await act(async () => budget('open'));
      await act(async () => budget('away'));
      await act(async () => cleared('open'));
      await act(async () => cleared('away'));
      expect(conversation.notice).toBe('tools');

      await act(async () => root.render(<Harness id="away" />));
      expect(conversation.notice).toBeNull();
    });

    it('shows notices that arrive together on separate lines while the conversation is open', async () => {
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => emit({ type: 'context-notice', sessionId: 'open', message: 'first', kind: 'no-tools' }));
      await act(async () =>
        emit({ type: 'context-notice', sessionId: 'open', message: 'second', kind: 'context-size' })
      );
      expect(conversation.notice).toBe('first\nsecond');
    });

    it('is dropped when the conversation is deleted', async () => {
      await act(async () => root.render(<Harness id="open" />));
      await act(async () => emit(noticeFor('gone')));
      await act(async () => {
        await sessions.remove('gone');
      });

      await act(async () => root.render(<Harness id="gone" />));
      expect(conversation.notice).toBeNull();
    });
  });
});

describe('refused send', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const session: ChatSession = {
    id: 's1',
    title: 'Chat',
    model: 'local:',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    messages: [],
  };
  const sendMessage = vi.fn();
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;

  function Harness() {
    conversation = useConversation('s1', () => {});
    return null;
  }

  beforeEach(() => {
    sendMessage.mockReset();
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession: async () => session,
          sendMessage,
          getQueuedMessages: async () => [],
          onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
          onQueueChanged: () => () => {},
          onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
        },
        claudeImport: { onSessionsChanged: () => () => {} },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe('a refused send', () => {
    it('reports false, shows the error, drops the optimistic message and hands the text back', async () => {
      sendMessage.mockResolvedValue({ ok: false, error: 'No local model is available.' });
      await act(async () => root.render(<Harness />));

      let sent: boolean | undefined;
      await act(async () => {
        sent = await conversation.send('keep this draft');
      });

      expect(sent).toBe(false);
      expect(conversation.sendError).toBe('No local model is available.');
      expect(conversation.messages).toEqual([]);
      expect(conversation.returned?.messages.map(message => message.text)).toEqual(['keep this draft']);
    });

    it('reports true when main accepts the turn', async () => {
      sendMessage.mockResolvedValue({ ok: true, messageId: 'm1' });
      await act(async () => root.render(<Harness />));
      let sent: boolean | undefined;
      await act(async () => {
        sent = await conversation.send('hello');
      });
      expect(sent).toBe(true);
      expect(conversation.returned).toBeNull();
    });
  });
});

describe('summary push', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const empty: ChatSession = {
    id: 's1',
    title: 'Chat',
    model: 'local:',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    createdAt: at,
    updatedAt: at,
    messages: [],
  };
  const answered: ChatSession = {
    ...empty,
    messages: [
      { id: 'u1', role: 'user', content: 'hello', createdAt: at },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Hi   there',
        createdAt: at,
        usage: { inputTokens: 1, outputTokens: 1, usdCost: 0.25, creditsUsed: 3 },
      },
    ],
  } as ChatSession;

  const onSummaryChanged = vi.fn<(summary: ChatSessionSummary) => void>();
  const getSession = vi.fn();
  let root: Root;
  let host: HTMLElement;
  let conversation: ConversationController;

  function Harness() {
    conversation = useConversation('s1', onSummaryChanged);
    return null;
  }

  beforeEach(() => {
    onSummaryChanged.mockReset();
    getSession.mockReset().mockResolvedValue(empty);
    Object.assign(window, {
      b4m: {
        host: chatBackedHostBridge(),
        chat: {
          getSession,
          sendMessage: async () => ({ ok: true, messageId: 'm1' }),
          getQueuedMessages: async () => [],
          onSessionSummary: () => () => {},
          onQueueChanged: () => () => {},
          onStreamEvent: () => () => {},
        },
        claudeImport: { onSessionsChanged: () => () => {} },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe('the summary pushed after a send', () => {
    it('carries the outcome, snippet and cost totals the sidebar and roster read', async () => {
      await act(async () => root.render(<Harness />));
      getSession.mockResolvedValue(answered);
      await act(async () => {
        await conversation.send('hello');
      });

      const pushed = onSummaryChanged.mock.calls.at(-1)?.[0];
      expect(pushed).toMatchObject({
        id: 's1',
        messageCount: 2,
        lastOutcome: 'finished',
        lastSnippet: 'Hi there',
        totalUsdCost: 0.25,
        totalCredits: 3,
      });
      expect(pushed).not.toHaveProperty('messages');
    });
  });
});

describe('delete prefs', () => {
  const summary = (id: string) =>
    ({
      id,
      title: id,
      mode: 'chat',
      messageCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }) as ChatSessionSummary;

  const storePrefs = (id: string) => {
    window.localStorage.setItem(`b4m.orchestrator.surface.${id}`, 'orchestrate');
    window.localStorage.setItem(`b4m.orchestrator.view.${id}`, 'board');
  };
  const hasPrefs = (id: string) =>
    window.localStorage.getItem(`b4m.orchestrator.surface.${id}`) !== null ||
    window.localStorage.getItem(`b4m.orchestrator.view.${id}`) !== null;

  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let controller: SessionsController | null = null;

  async function mount() {
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: {
        listSessions: vi.fn(() => Promise.resolve([summary('listed')])),
        deleteSession: vi.fn(() => Promise.resolve()),
        onSessionSummary: vi.fn(() => () => {}),
        onStreamEvent: vi.fn(() => () => {}),
      },
    };
    function Harness() {
      controller = useSessions();
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));
  }

  beforeEach(() => window.localStorage.clear());

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    controller = null;
  });

  describe('orchestrator prefs and the session list', () => {
    it('keeps prefs of sessions the listing does not include, such as another account scope', async () => {
      storePrefs('listed');
      storePrefs('other-scope');
      await mount();
      expect(controller?.loading).toBe(false);
      expect(hasPrefs('listed')).toBe(true);
      expect(hasPrefs('other-scope')).toBe(true);
    });

    it('forgets a session prefs when that session is deleted, and only its', async () => {
      storePrefs('listed');
      storePrefs('other-scope');
      await mount();
      await act(async () => controller?.remove('listed'));
      expect(hasPrefs('listed')).toBe(false);
      expect(hasPrefs('other-scope')).toBe(true);
    });
  });
});

describe('reload ordering', () => {
  const summary = (id: string) =>
    ({
      id,
      title: id,
      mode: 'chat',
      messageCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }) as ChatSessionSummary;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(settle => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function mount(listSessions: () => Promise<ChatSessionSummary[]>) {
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: {
        listSessions,
        onSessionSummary: vi.fn(() => () => {}),
        onStreamEvent: vi.fn(() => () => {}),
      },
    };
    let controller: SessionsController | null = null;
    function Harness() {
      controller = useSessions();
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));
    return () => {
      if (!controller) throw new Error('not mounted');
      return controller;
    };
  }

  // The first send in a new chat awaits a reload and then selects the new id, and the shell
  // reselects away from an open id the list lacks. So a reload must not resolve before a list that
  // contains what it read has been applied, even when a newer reload (a status push) overtook it.
  describe('reloading the session list', () => {
    it('resolves an overtaken reload only once the newer listing has been applied', async () => {
      const first = deferred<ChatSessionSummary[]>();
      const second = deferred<ChatSessionSummary[]>();
      const listSessions = vi
        .fn<() => Promise<ChatSessionSummary[]>>()
        .mockResolvedValueOnce([summary('old')])
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const controller = await mount(listSessions);

      let firstDone = false;
      let firstReload: Promise<void> = Promise.resolve();
      await act(async () => {
        firstReload = controller()
          .reload()
          .then(() => {
            firstDone = true;
          });
        void controller().reload();
        first.resolve([summary('fresh'), summary('old')]);
      });
      expect(firstDone).toBe(false);

      // The listing now crosses the host bridge, so it settles some microtasks after the stub
      // does; the rendered list is read once act has flushed the update the reload applied.
      await act(async () => {
        second.resolve([summary('fresh'), summary('old')]);
        await firstReload;
      });

      expect(firstDone).toBe(true);
      expect(controller().sessions.map(session => session.id)).toContain('fresh');
    });

    it('still lets the newer listing win when the older one lands last', async () => {
      const first = deferred<ChatSessionSummary[]>();
      const second = deferred<ChatSessionSummary[]>();
      const listSessions = vi
        .fn<() => Promise<ChatSessionSummary[]>>()
        .mockResolvedValueOnce([summary('old')])
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const controller = await mount(listSessions);

      let pending!: Promise<void>;
      await act(async () => {
        pending = controller().reload();
        void controller().reload();
        second.resolve([summary('newer'), summary('old')]);
      });
      await act(async () => {
        first.resolve([summary('old')]);
        await pending;
      });

      expect(controller().sessions.map(session => session.id)).toEqual(['newer', 'old']);
    });

    it('resolves a reload overtaken twice only once the last listing has been applied', async () => {
      const first = deferred<ChatSessionSummary[]>();
      const second = deferred<ChatSessionSummary[]>();
      const third = deferred<ChatSessionSummary[]>();
      const listSessions = vi
        .fn<() => Promise<ChatSessionSummary[]>>()
        .mockResolvedValueOnce([summary('old')])
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(third.promise);
      const controller = await mount(listSessions);

      let firstDone = false;
      await act(async () => {
        void controller()
          .reload()
          .then(() => {
            firstDone = true;
          });
        void controller().reload();
        void controller().reload();
        first.resolve([summary('old')]);
        second.resolve([summary('old')]);
      });
      expect(firstDone).toBe(false);

      await act(async () => third.resolve([summary('fresh'), summary('old')]));

      expect(firstDone).toBe(true);
      expect(controller().sessions.map(session => session.id)).toEqual(['fresh', 'old']);
    });

    it('re-lists when a local edit lands while an overtaking listing is in flight', async () => {
      const first = deferred<ChatSessionSummary[]>();
      const second = deferred<ChatSessionSummary[]>();
      const listSessions = vi
        .fn<() => Promise<ChatSessionSummary[]>>()
        .mockResolvedValueOnce([summary('old')])
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockResolvedValueOnce([summary('relisted'), summary('old')]);
      const controller = await mount(listSessions);

      let firstDone = false;
      await act(async () => {
        void controller()
          .reload()
          .then(() => {
            firstDone = true;
          });
        void controller().reload();
        controller().apply(summary('old'));
        first.resolve([summary('old')]);
        second.resolve([summary('stale')]);
      });

      expect(listSessions).toHaveBeenCalledTimes(4);
      expect(firstDone).toBe(true);
      expect(controller().sessions.map(session => session.id)).toEqual(['relisted', 'old']);
    });

    it('rejects an overtaken reload when the newer listing fails', async () => {
      const first = deferred<ChatSessionSummary[]>();
      const listSessions = vi
        .fn<() => Promise<ChatSessionSummary[]>>()
        .mockResolvedValueOnce([summary('old')])
        .mockReturnValueOnce(first.promise)
        .mockRejectedValueOnce(new Error('list failed'));
      const controller = await mount(listSessions);

      let outcome: unknown = null;
      await act(async () => {
        controller()
          .reload()
          .catch(error => {
            outcome = error;
          });
        controller()
          .reload()
          .catch(() => {});
        first.resolve([summary('old')]);
      });

      expect(outcome).toEqual(new Error('list failed'));
      expect(controller().sessions.map(session => session.id)).toEqual(['old']);
    });
  });
});

describe('session placement', () => {
  const summary = (id: string, extra: Partial<ChatSessionSummary> = {}) =>
    ({
      id,
      title: id,
      mode: 'chat',
      messageCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...extra,
    }) as ChatSessionSummary;

  const work: SidebarSectionsState = { sections: [{ id: 'work', name: 'Work' }], assignments: {} };
  const placed: SidebarSectionsState = { ...work, assignments: { fresh: 'work' } };

  let root: Root | null = null;
  let host: HTMLElement | null = null;

  /** Where the new row sat on every render, so a single frame in the default list is caught. */
  type Placement = 'absent' | 'loose' | 'work';

  async function mount(
    chat: { createSession?: unknown; createCodeSession?: unknown; listSessions?: unknown; onStreamEvent?: unknown },
    mode: ChatSessionMode = 'chat',
    sidebarStubs: Record<string, unknown> = {}
  ) {
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: {
        listSessions: vi.fn(() => Promise.resolve([summary('old')])),
        onSessionSummary: vi.fn(() => () => {}),
        onStreamEvent: vi.fn(() => () => {}),
        ...chat,
      },
      sidebar: { getSections: vi.fn(() => Promise.resolve(work)), ...sidebarStubs },
    };
    const seen: Placement[] = [];
    let controller: SessionsController | null = null;
    let adopt: ((state: SidebarSectionsState) => void) | null = null;

    function Harness() {
      const sessions = useSessions();
      const sidebar = useSidebarSections();
      controller = sessions;
      adopt = sidebar.adopt;
      const groups = groupSessions(sessions.sessions, mode, sidebar.sections);
      const inWork = groups.custom.some(group => group.sessions.some(session => session.id === 'fresh'));
      const loose = groups.loose.some(session => session.id === 'fresh');
      seen.push(inWork ? 'work' : loose ? 'loose' : 'absent');
      return null;
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));

    /** The failure channel every placement in these tests gets, so a silent one is caught. */
    const failed = vi.fn();
    const start = async (
      create: (
        sessions: SessionsController,
        placed: (state: SidebarSectionsState) => void,
        failed: () => void
      ) => unknown
    ) => {
      if (!controller || !adopt) throw new Error('not mounted');
      const target = controller;
      const place = adopt;
      let id: unknown;
      await act(async () => {
        id = await create(target, place, failed);
      });
      return id;
    };
    return { seen, start, failed, controller: () => controller };
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe('starting a session in a sidebar section', () => {
    it('drops a failed spawned session after its final status listing still contained it', async () => {
      let listener: ((event: ChatStreamEvent) => void) | undefined;
      const listSessions = vi
        .fn()
        .mockResolvedValueOnce([summary('old'), summary('failed')])
        .mockResolvedValue([summary('old')]);
      const { controller } = await mount({
        listSessions,
        onStreamEvent: (callback: (event: ChatStreamEvent) => void) => {
          listener = callback;
          return () => {};
        },
      });
      expect(controller()?.sessions.map(session => session.id)).toContain('failed');

      await act(async () => {
        listener?.({ type: 'spawn-failed', sessionId: 'old', title: 'failed', message: 'Could not cut worktree' });
      });

      expect(controller()?.sessions.map(session => session.id)).toEqual(['old']);
    });
    it('draws a new Chat session inside its section from its first render', async () => {
      const createSession = vi.fn((): Promise<CreatedSession> =>
        Promise.resolve({ session: summary('fresh'), sidebarSections: placed })
      );
      const { seen, start, failed } = await mount({ createSession });

      const id = await start((sessions, place, failure) =>
        sessions.create({ sectionId: 'work', placed: place, failed: failure })
      );

      expect(id).toBe('fresh');
      expect(createSession).toHaveBeenCalledWith({ sectionId: 'work' });
      expect(seen.at(-1)).toBe('work');
      expect(seen).not.toContain('loose');
      expect(failed).not.toHaveBeenCalled();
    });

    it('draws a new Code session inside its section from its first render', async () => {
      const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
        Promise.resolve({ ok: true, session: summary('fresh', { mode: 'code' }) })
      );
      const moveSession = vi.fn(() => Promise.resolve(placed));
      const { seen, start } = await mount({ createCodeSession }, 'code', { moveSession });

      await start((sessions, place, failure) =>
        sessions.createCode({}, { sectionId: 'work', placed: place, failed: failure })
      );

      expect(createCodeSession).toHaveBeenCalledWith({});
      expect(moveSession).toHaveBeenCalledWith('fresh', 'work');
      expect(seen.at(-1)).toBe('work');
      expect(seen).not.toContain('loose');
    });

    it('falls back to the default list when a Code session could not be moved into its section', async () => {
      const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
        Promise.resolve({ ok: true, session: summary('fresh', { mode: 'code' }) })
      );
      const moveSession = vi.fn(() => Promise.reject(new Error('section gone')));
      const placedSpy = vi.fn();
      const { seen, start, failed } = await mount({ createCodeSession }, 'code', { moveSession });

      await start((sessions, _place, failure) =>
        sessions.createCode({}, { sectionId: 'work', placed: placedSpy, failed: failure })
      );

      expect(placedSpy).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalled();
      expect(seen.at(-1)).toBe('loose');
    });

    it('asks for no section and adds the row to the default list from plain New', async () => {
      const createSession = vi.fn((): Promise<CreatedSession> => Promise.resolve({ session: summary('fresh') }));
      const { seen, start } = await mount({ createSession });

      await start(sessions => sessions.create());

      expect(createSession).toHaveBeenCalledWith(undefined);
      expect(seen.at(-1)).toBe('loose');
    });

    it('falls back to the default list when main could not save the placement', async () => {
      const createSession = vi.fn((): Promise<CreatedSession> =>
        Promise.resolve({ session: summary('fresh'), placementFailed: true })
      );
      const placedSpy = vi.fn();
      const { seen, start, failed } = await mount({ createSession });

      await start((sessions, _place, failure) =>
        sessions.create({ sectionId: 'work', placed: placedSpy, failed: failure })
      );

      expect(placedSpy).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalled();
      expect(seen.at(-1)).toBe('loose');
    });

    it('reports a refused Code session and places nothing', async () => {
      const createCodeSession = vi.fn((): Promise<CreateCodeSessionResult> =>
        Promise.resolve({ ok: false, error: 'no worktree' })
      );
      const placedSpy = vi.fn();
      const { seen, start, failed, controller } = await mount({ createCodeSession });

      const id = await start((sessions, _place, failure) =>
        sessions.createCode({}, { sectionId: 'work', placed: placedSpy, failed: failure })
      );

      expect(id).toBeNull();
      expect(controller()?.codeError).toBe('no worktree');
      expect(placedSpy).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(seen.at(-1)).toBe('absent');
    });
  });
});

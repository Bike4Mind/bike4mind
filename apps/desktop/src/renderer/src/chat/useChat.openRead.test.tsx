// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  Object.assign(window, { b4m: { chat, claudeImport: { onSessionsChanged: () => () => {} } } });
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
      window.b4m.chat.onSessionSummary = listener => {
        invalidate = () => listener(summaryFor('s1', { title: 'Updated' }));
        return () => {};
      };
    } else {
      window.b4m.chat.onStreamEvent = listener => {
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
    getSession.mockRejectedValue(new Error("Error invoking remote method 'chat:get-session': Error: database locked"));
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
    window.b4m.chat.onStreamEvent = listener => {
      emit = listener;
      return () => {};
    };
  });

  it('opens a resumed run that kept the settled id', async () => {
    getSession.mockImplementation(async id => (id === 's1' ? running('x') : sessionFor(id)));
    await act(async () => root.render(<Harness id="s2" />));
    await act(async () => {
      emit({ type: 'done', sessionId: 's1', messageId: 'x', content: '' });
      emit({ type: 'start', sessionId: 's1', messageId: 'x' });
    });
    await act(async () => root.render(<Harness id="s1" />));
    expect(conversation.session?.id).toBe('s1');
    expect(conversation.messages[0]).toEqual(prompt);
    expect(conversation.streaming).toBe(true);
    expect(readsOf('s1')).toBe(1);
  });

  it('stops re-reading and opens the chat when the live copy keeps naming a settled reply', async () => {
    getSession.mockImplementation(async id => (id === 's1' ? running('x') : sessionFor(id)));
    await act(async () => root.render(<Harness id="s2" />));
    await act(async () => emit({ type: 'error', sessionId: 's1', messageId: 'x', message: 'boom' }));
    await act(async () => root.render(<Harness id="s1" />));
    expect(conversation.session?.id).toBe('s1');
    expect(conversation.messages[0]).toEqual(prompt);
    expect(conversation.streaming).toBe(true);
    expect(conversation.turn?.startedAt).toBe(10);
    expect(readsOf('s1')).toBe(4);
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

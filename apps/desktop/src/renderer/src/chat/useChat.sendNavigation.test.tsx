// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatStreamEvent, SendMessageResult } from '@shared/chat';
import { MessageThread } from './MessageThread';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  summaryChanged.mockReset();
  Element.prototype.scrollIntoView = () => undefined;
  Object.assign(window, {
    b4m: {
      chat: {
        getSession,
        sendMessage,
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

  it.each([true, false])('ignores a send acknowledgement arriving after navigation (accepted: %s)', async accepted => {
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
  });
});

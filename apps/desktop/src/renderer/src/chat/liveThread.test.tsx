// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { TurnStatus } from './TurnStatus';
import { useConversation } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 's1';
const MESSAGE = 'm1';

function call(id: string, name = 'file_read', status: ChatToolCall['status'] = 'running'): ChatToolCall {
  return { id, name, input: { path: `src/${id}.ts` }, status };
}

function Harness() {
  const conversation = useConversation(SESSION, () => undefined);
  return (
    <MessageThread
      messages={conversation.messages}
      sessionId={SESSION}
      streaming={conversation.streaming}
      onRespond={() => undefined}
      onContinue={() => undefined}
      status={
        conversation.turn && (
          <TurnStatus turn={conversation.turn} activity={{ kind: 'thinking', label: 'Thinking...' }} />
        )
      }
    />
  );
}

describe('the live thread, driven by stream events', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listener: ((event: ChatStreamEvent) => void) | null;
  let frames: FrameRequestCallback[];

  const emit = (event: ChatStreamEvent) => act(() => listener?.(event));
  const paint = () =>
    act(() => {
      const due = frames;
      frames = [];
      due.forEach(frame => frame(performance.now()));
    });

  beforeEach(() => {
    listener = null;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    Element.prototype.scrollIntoView = () => undefined;
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        getSession: async () => ({ id: SESSION, messages: [] }),
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => undefined,
        onQueueChanged: () => () => undefined,
        onStreamEvent: (next: (event: ChatStreamEvent) => void) => {
          listener = next;
          return () => undefined;
        },
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => root.render(<Harness />));
    await act(async () => undefined);
  }

  const text = (delta: string): ChatStreamEvent => ({
    type: 'delta',
    sessionId: SESSION,
    messageId: MESSAGE,
    text: delta,
  });

  it('keeps the turn status on screen from start to done, and every delta in the reply', async () => {
    await mount();
    emit({ type: 'start', sessionId: SESSION, messageId: MESSAGE });
    expect(container.querySelector('[data-testid="chat-turn-status"]')).not.toBeNull();

    emit(text('Reading '));
    emit(text('the files.'));
    emit({ type: 'tool-start', sessionId: SESSION, messageId: MESSAGE, call: call('a') });
    emit({ type: 'tool-end', sessionId: SESSION, messageId: MESSAGE, call: call('a', 'file_read', 'done') });
    emit({
      type: 'usage',
      sessionId: SESSION,
      messageId: MESSAGE,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(container.querySelector('[data-testid="chat-turn-status"]')).not.toBeNull();
    paint();
    emit(text('All '));
    emit(text('done.'));
    expect(container.querySelector('[data-testid="chat-turn-status"]')).not.toBeNull();
    paint();
    expect(container.textContent).toContain('All done.');
    expect(container.querySelector('[data-testid="chat-turn-status"]')).not.toBeNull();

    emit({ type: 'delta', sessionId: SESSION, messageId: MESSAGE, text: ' Bye.' });
    emit({
      type: 'done',
      sessionId: SESSION,
      messageId: MESSAGE,
      content: 'Reading the files.\n\nAll done. Bye.',
    });
    expect(container.querySelector('[data-testid="chat-turn-status"]')).toBeNull();
    expect(container.textContent).toContain('All done. Bye.');
  });

  it('does not remount tool rows while later events stream in', async () => {
    await mount();
    emit({ type: 'start', sessionId: SESSION, messageId: MESSAGE });
    emit(text('Looking.'));
    emit({ type: 'tool-start', sessionId: SESSION, messageId: MESSAGE, call: call('a') });
    emit({ type: 'tool-end', sessionId: SESSION, messageId: MESSAGE, call: call('a', 'file_read', 'done') });
    paint();
    const row = container.querySelector('[data-testid="chat-tool-row"]');
    expect(row).not.toBeNull();

    for (const id of ['b', 'c', 'd', 'e', 'f']) {
      emit({ type: 'tool-start', sessionId: SESSION, messageId: MESSAGE, call: call(id) });
      paint();
      emit({ type: 'tool-end', sessionId: SESSION, messageId: MESSAGE, call: call(id, 'file_read', 'done') });
      paint();
      emit(text('\n'));
      paint();
      expect(row?.isConnected).toBe(true);
    }
    expect(container.querySelector('[data-testid="chat-tool-row"]')).toBe(row);
  });

  it('folds live events on a timer when animation frames never fire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await mount();
      emit({ type: 'start', sessionId: SESSION, messageId: MESSAGE });
      emit(text('Hidden window text.'));
      expect(container.textContent).not.toContain('Hidden window text.');
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(container.textContent).toContain('Hidden window text.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the turn status when a message lands after the reply mid-turn', async () => {
    await mount();
    emit({ type: 'start', sessionId: SESSION, messageId: MESSAGE });
    emit({
      type: 'message',
      sessionId: SESSION,
      message: { id: 'sys1', role: 'user', system: true, content: 'report', createdAt: new Date().toISOString() },
    } as ChatStreamEvent);
    expect(container.querySelectorAll('[data-testid="chat-turn-status"]').length).toBe(1);
  });
});

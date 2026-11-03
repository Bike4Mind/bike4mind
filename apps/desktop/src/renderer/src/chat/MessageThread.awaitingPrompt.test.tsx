// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitingApprovalKey, MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

const call = (overrides: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id: 'c1',
  name: 'bash',
  input: { command: 'rm -rf build' },
  status: 'running',
  ...overrides,
});

const reply = (toolCalls: ChatToolCall[]): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content: 'Cleaning up.',
  createdAt: new Date().toISOString(),
  toolCalls,
});

describe('awaitingApprovalKey', () => {
  it('is empty with nothing to answer', () => {
    expect(awaitingApprovalKey(undefined)).toBe('');
    expect(awaitingApprovalKey(reply([call()]))).toBe('');
  });

  it('names each prompt the message is parked on', () => {
    const message = reply([
      call({ id: 'c1', status: 'awaiting-approval', approvalId: 'p1' }),
      call({ id: 'c2', status: 'done' }),
      call({ id: 'c3', status: 'awaiting-approval', approvalId: 'p3' }),
    ]);
    expect(awaitingApprovalKey(message)).toBe('p1,p3');
  });
});

describe('a prompt arriving in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (message: ChatMessage) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={[message]}
            sessionId="s1"
            streaming
            onRespond={() => undefined}
            onContinue={() => undefined}
          />
        </CssVarsProvider>
      )
    );

  /** The reader scrolls well up from the bottom, which unpins the thread from following. */
  const scrollUp = () => {
    const host = container.querySelector<HTMLElement>('[data-testid="chat-thread"]');
    if (!host) throw new Error('thread did not render');
    Object.defineProperty(host, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 800 });
    host.scrollTop = 1000;
    act(() => {
      host.dispatchEvent(new Event('scroll'));
    });
  };

  it('is brought into view even when the reader had scrolled up', () => {
    render(reply([call()]));
    scrollUp();
    scrollIntoView.mockClear();

    // Same message, same number of calls: only the status changes.
    render(reply([call({ status: 'awaiting-approval', approvalId: 'p1' })]));

    expect(container.querySelector('[data-testid="chat-tool-approval"]')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
  });

  it('leaves a scrolled-up reader alone while nothing new is asked', () => {
    render(reply([call()]));
    scrollUp();
    scrollIntoView.mockClear();

    render(reply([call({ preview: 'still going' })]));

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

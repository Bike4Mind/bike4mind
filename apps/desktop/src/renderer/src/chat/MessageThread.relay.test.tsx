// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { SessionOpenerContext } from './SessionLink';

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

const TARGET = '33333333-3333-4333-8333-333333333333';

describe('relay rows and session mentions in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;
  let open: ReturnType<typeof vi.fn<(id: string) => void>>;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    open = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (message: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <SessionOpenerContext.Provider value={open}>
            <MessageThread
              messages={[{ id: 'm1', createdAt: new Date().toISOString(), ...message }]}
              sessionId="s1"
              streaming={false}
              onRespond={() => undefined}
              onContinue={() => undefined}
            />
          </SessionOpenerContext.Provider>
        </CssVarsProvider>
      )
    );

  const byId = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('opens the sender from the relay row without toggling the disclosure', () => {
    render({
      role: 'user',
      content: 'please check',
      relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', fromProject: 'docs', hops: 1 },
    });
    expect(byId('chat-message-relay-summary')?.textContent).toContain('Received message from Docs pass (docs)');

    const details = byId('chat-message-relay') as HTMLDetailsElement;
    const link = byId('relay-sender-link');
    let defaultPrevented = false;
    act(() => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
    });
    expect(open).toHaveBeenCalledWith('sender-1');
    expect(defaultPrevented).toBe(true);
    expect(details.open).toBe(false);
  });

  it('reads a done notice as the sender finishing', () => {
    render({
      role: 'user',
      content: 'app text',
      relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', hops: 1, kind: 'done' },
    });
    expect(byId('chat-message-relay-summary')?.textContent).toBe('Docs pass finished the turn your message started');
  });

  it('draws a mention in a user message as a link to that session', () => {
    render({ role: 'user', content: `look at @[Docs pass](session:${TARGET}) please` });
    const link = byId('session-mention-link');
    expect(link?.textContent).toBe('@Docs pass');
    expect(byId('chat-message-user-text')?.textContent).toBe('look at @Docs pass please');
    act(() => link?.click());
    expect(open).toHaveBeenCalledWith(TARGET);
  });
});

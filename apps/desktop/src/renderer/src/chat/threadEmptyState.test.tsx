// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An empty pane has two causes and they need different words. Both used to read "Send a message
 * to start this conversation.", which on a fresh install invited a message into a conversation
 * that did not exist and that the composer would not have taken one for.
 */
describe('the empty transcript', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (sessionId: string | null) =>
    act(() => {
      root.render(
        <MessageThread
          messages={[]}
          sessionId={sessionId}
          noSession={<button data-testid="chat-start-session-btn">New conversation</button>}
          streaming={false}
          onRespond={() => undefined}
          onContinue={() => undefined}
        />
      );
    });

  it('invites a message only when there is a conversation to send it to', () => {
    render('s1');
    expect(container.querySelector('[data-testid="chat-thread-empty"]')?.textContent).toContain('Send a message');
    expect(container.querySelector('[data-testid="chat-start-session-btn"]')).toBeNull();
  });

  it('offers the way in when there is no conversation at all', () => {
    render(null);
    expect(container.querySelector('[data-testid="chat-start-session-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-thread-empty"]')).toBeNull();
  });
});

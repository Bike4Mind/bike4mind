// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(id: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', ...fields };
}

/**
 * The hover figure says what a reply cost. The cases that matter are the ones where there is
 * no figure: rendering those as "0 credits" would tell the user a turn was free.
 */
describe('the cost on a reply', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (messages: ChatMessage[]) =>
    act(() => {
      root.render(
        <MessageThread
          messages={messages}
          sessionId="s1"
          streaming={false}
          onRespond={() => undefined}
          onContinue={() => undefined}
        />
      );
    });

  const costs = () => Array.from(container.querySelectorAll('[data-testid="chat-message-cost"]'));

  it('states the credits the reply spent, with the split and the dollar behind it', () => {
    render([message('m1', { usage: { inputTokens: 1200, outputTokens: 300, creditsUsed: 54, usdCost: 0.027 } })]);

    const row = costs()[0];
    expect(row?.textContent).toBe('54 credits');
    expect(row?.getAttribute('title')).toBe('1.2k new input, 300 output\n$0.03');
  });

  // jsdom cannot hover, so the half worth pinning is that the turn's rule reached this row at
  // all: hidden at rest is what makes the reveal CSS rather than a render per mouse move.
  it('is hidden until the turn around it is hovered', () => {
    render([message('m1', { usage: { creditsUsed: 54 } })]);

    const row = costs()[0] as HTMLElement;
    expect(getComputedStyle(row).opacity).toBe('0');
  });

  it('shows nothing on a reply the server reported no credits for', () => {
    render([
      message('m1'),
      message('m2', { usage: { inputTokens: 900 } }),
      message('m3', { error: 'The turn failed' }),
    ]);

    expect(costs()).toHaveLength(0);
  });

  it('leaves the user, relay and system turns alone', () => {
    render([
      message('u1', { role: 'user', content: 'hello' }),
      message('r1', {
        relay: { fromSessionId: 's2', fromTitle: 'Another conversation', hops: 1 },
        usage: { creditsUsed: 12 },
      }),
      message('y1', { system: true, usage: { creditsUsed: 12 } }),
    ]);

    expect(costs()).toHaveLength(0);
  });
});

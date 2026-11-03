// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';
import { reloadReplyStatsPrefs, setReplyStatShown } from './replyStatsPrefs';

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
    window.localStorage.clear();
    reloadReplyStatsPrefs();
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

  it('states the credits the reply spent, with token details and no dollars', () => {
    render([message('m1', { usage: { inputTokens: 1200, outputTokens: 300, creditsUsed: 54, usdCost: 0.027 } })]);

    const row = costs()[0];
    expect(row?.textContent).toBe('54 credits');
    expect(row?.getAttribute('title')).toBe('1.2k new input, 300 output\nTotal tokens: 300');
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

  describe('on a self-hosted model reply', () => {
    const usage = { inputTokens: 300, outputTokens: 48, rate: { evalTokens: 48, evalMs: 2000, loadMs: 1200 } };

    it('shows the generation rate where credits would be, with details in the title', () => {
      render([message('m1', { usage })]);

      const row = costs()[0];
      expect(row?.textContent).toBe('24.0 tok/s');
      expect(row?.querySelector('[data-testid="chat-message-stat-speed"]')).not.toBeNull();
      expect(row?.getAttribute('title')).toBe(
        '300 new input, 48 output\nTotal tokens: 48\nSpeed: 24.0 tok/s\nLoad time: 1.2s'
      );
    });

    it('leaves out a stat unticked in Settings, keeps it in the title, and shows nothing with no other', () => {
      act(() => setReplyStatShown('speed', false));
      render([message('m1', { usage })]);

      expect(costs()).toHaveLength(0);
      render([message('m1', { usage: { ...usage, creditsUsed: 2 } })]);
      expect(costs()[0]?.textContent).toBe('2 credits');
      expect(costs()[0]?.getAttribute('title')).toContain('Speed: 24.0 tok/s');
    });
  });

  it('names speed, total and thinking time only, speed first and credits last, each with its kind', () => {
    render([
      message('m1', {
        usage: { inputTokens: 100, outputTokens: 400, cacheReadInputTokens: 900, creditsUsed: 12 },
        stats: {
          totalMs: 10_000,
          modelMs: 10_000,
          toolMs: 0,
          firstTokenMs: 1500,
          reasoningMs: 1500,
          generation: { tokens: 400, ms: 8000 },
          derived: ['reasoningMs'],
        },
      }),
    ]);

    expect(costs()[0]?.textContent).toBe('~50.0 tok/s \xb7 10.0s total \xb7 ~1.5s thinking \xb7 12 credits');
    expect(costs()[0]?.getAttribute('title')).toContain('Thinking share: ~15%');
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

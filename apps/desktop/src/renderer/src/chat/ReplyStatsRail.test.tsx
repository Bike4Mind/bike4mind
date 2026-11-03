// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatReplyStats } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { RAIL_ROW_HEIGHT, railReserve } from './ReplyStatsRail';
import { REPLY_STATS } from './replyStats';
import { reloadReplyStatsPrefs, setReplyStatShown } from './replyStatsPrefs';
import type { TurnProgress } from './statusLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stats: ChatReplyStats = {
  totalMs: 12_000,
  modelMs: 12_000,
  toolMs: 0,
  firstTokenMs: 800,
  reasoningMs: 3000,
  generation: { tokens: 299, ms: 11_200 },
};

function message(id: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', ...fields };
}

describe('railReserve', () => {
  it('holds a short reply tall enough that its rail ends a row clear of the next one', () => {
    // A 24px gap, a 22px relay row and the gap again, less 12px between the two rails.
    expect(railReserve(3)).toBe(0);
    expect(railReserve(9)).toBe(9 * RAIL_ROW_HEIGHT - 58);
  });

  it('holds the last reply open to its whole rail, which has nothing after it to run into', () => {
    expect(railReserve(3, true)).toBe(3 * RAIL_ROW_HEIGHT);
    expect(railReserve(9, true)).toBe(9 * RAIL_ROW_HEIGHT);
  });
});

describe('the reply stats rail and its footer fallback', () => {
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
    vi.useRealTimers();
  });

  const render = (
    messages: ChatMessage[],
    props: { statsRail?: boolean; streaming?: boolean; liveTurn?: TurnProgress | null } = {}
  ) =>
    act(() => {
      root.render(
        <MessageThread
          messages={messages}
          sessionId="s1"
          streaming={props.streaming ?? false}
          onRespond={() => undefined}
          onContinue={() => undefined}
          {...(props.statsRail !== undefined ? { statsRail: props.statsRail } : {})}
          {...(props.liveTurn !== undefined ? { liveTurn: props.liveTurn } : {})}
        />
      );
    });

  const rails = () => Array.from(container.querySelectorAll('[data-testid="chat-reply-stats-rail"]'));
  const footers = () => Array.from(container.querySelectorAll('[data-testid="chat-message-cost"]'));
  const statValue = (id: string) =>
    container.querySelector(`[data-testid="chat-reply-stat-${id}"]`)?.lastElementChild?.textContent;

  const settled = [
    message('u1', { role: 'user', content: 'Is 221 prime?' }),
    message('a1', { content: 'No: 13 x 17.', stats, usage: { inputTokens: 40, outputTokens: 300, creditsUsed: 3 } }),
  ];

  it('draws the rail beside each reply and leaves the footer to Copy', () => {
    render(settled, { statsRail: true });

    expect(rails()).toHaveLength(1);
    expect(footers()).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-message-assistant-copy-btn"]')).not.toBeNull();
    expect(statValue('thinking')).toBe('3.0s');
    expect(statValue('total')).toBe('12.0s');
    expect(statValue('thinkingShare')).toBe('25%');
    expect(statValue('cost')).toBe('3 credits');
  });

  it('falls back to the hover footer when the rail is off or does not fit', () => {
    render(settled, { statsRail: false });

    expect(rails()).toHaveLength(0);
    expect(footers()[0]?.textContent).toContain('3.0s thinking');
  });

  it('draws no rail for the user turn, nor for a reply with nothing measured', () => {
    render([...settled, message('u2', { role: 'user', content: 'Thanks' }), message('a2', { content: 'Sure.' })], {
      statsRail: true,
    });

    expect(rails()).toHaveLength(1);
  });

  it('leaves out the stats unticked in Settings', () => {
    act(() => setReplyStatShown('thinkingShare', false));
    render(settled, { statsRail: true });

    expect(statValue('thinkingShare')).toBeUndefined();
    expect(statValue('thinking')).toBe('3.0s');
    const spoken = container.querySelector('[data-testid="chat-reply-stats-spoken"]')?.textContent ?? '';
    expect(spoken).toContain('Thinking time 3.0s');
    expect(spoken).not.toContain('Thinking share');
  });

  it('still draws the cost with every stat unticked', () => {
    act(() => REPLY_STATS.forEach(id => setReplyStatShown(id, false)));
    render(settled, { statsRail: true });

    expect(rails()).toHaveLength(1);
    expect(statValue('thinking')).toBeUndefined();
    expect(statValue('cost')).toBe('3 credits');
  });

  it('reads as one labelled sentence to a screen reader, the rows hidden and the estimates explained', () => {
    const thought = { ...stats, toolMs: 2000, derived: ['reasoningMs' as const] };
    render([message('a1', { content: 'No.', stats: thought, usage: { outputTokens: 300, creditsUsed: 3 } })], {
      statsRail: true,
    });

    const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Reply stats"]');
    const rows = group?.querySelector('[aria-hidden="true"]');
    expect(rows?.contains(container.querySelector('[data-testid="chat-reply-stat-thinking"]'))).toBe(true);
    const spoken = container.querySelector('[data-testid="chat-reply-stats-spoken"]')?.textContent ?? '';
    expect(group?.contains(container.querySelector('[data-testid="chat-reply-stats-spoken"]'))).toBe(true);
    expect(spoken.startsWith('Thinking time about 3.0s, estimated from the wait before the first output; ')).toBe(true);
    expect(spoken).toContain('Total time 12.0s, includes 2.0s running tools and waiting for approval;');
    expect(spoken.endsWith('; Cost 3 credits.')).toBe(true);
    expect(container.querySelector('[data-testid="chat-reply-stat-total"]')?.getAttribute('title')).toBe(
      'includes 2.0s running tools and waiting for approval'
    );
  });

  it('holds a short reply open to its rail height, the cost row included, and only while the rail is drawn', () => {
    const replies = () => container.querySelectorAll<HTMLElement>('[data-testid="chat-message-assistant"]');
    const local = message('a1', {
      content: 'No.',
      stats: { ...stats, reasoningTokens: 90, derived: ['reasoningTokens'] },
      usage: {
        inputTokens: 40,
        outputTokens: 300,
        creditsUsed: 1,
        rate: { evalTokens: 300, evalMs: 11_000, promptTokens: 40, promptMs: 80, loadMs: 900 },
      },
    });
    const thread = [local, message('u2', { role: 'user', content: 'And 223?' }), { ...local, id: 'a2' }];

    render(thread, { statsRail: true });
    // Thinking, total, share, thinking tokens, tokens and speed, then the cost; the server timings are off by default.
    expect(getComputedStyle(replies()[0]!).minHeight).toBe(`${railReserve(7)}px`);
    expect(getComputedStyle(replies()[1]!).minHeight).toBe(`${railReserve(7, true)}px`);

    act(() => setReplyStatShown('load', true));
    render(thread, { statsRail: true });
    expect(getComputedStyle(replies()[0]!).minHeight).toBe(`${railReserve(8)}px`);

    render(thread, { statsRail: false });
    expect(getComputedStyle(replies()[0]!).minHeight).not.toBe(`${railReserve(8)}px`);
    expect(getComputedStyle(replies()[1]!).minHeight).not.toBe(`${railReserve(8, true)}px`);
  });

  it('ticks the live reply off its own clock, leaving the total and speed to the status line', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(20_000);
    act(() => setReplyStatShown('firstToken', true));
    const turn: TurnProgress = {
      startedAt: 14_000,
      tokens: null,
      requestAt: 15_000,
      firstTokenAt: 15_500,
      thinkingSince: 16_000,
      usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1000 } },
    };

    render([message('u1', { role: 'user', content: 'Think hard' }), message('a1', { content: '' })], {
      statsRail: true,
      streaming: true,
      liveTurn: turn,
    });
    expect(statValue('thinking')).toBe('4s');
    expect(statValue('firstToken')).toBe('500ms');
    expect(statValue('total')).toBeUndefined();
    expect(statValue('speed')).toBeUndefined();

    act(() => vi.advanceTimersByTime(2000));
    expect(statValue('thinking')).toBe('6s');
  });

  describe('while a reply is continued', () => {
    const at = 20_000;
    const turn: TurnProgress = {
      startedAt: at - 5000,
      tokens: null,
      messageId: 'a1',
      continued: true,
      requestAt: at - 4500,
      firstTokenAt: at - 4000,
      thinkingSince: at - 2000,
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(at);
      act(() => setReplyStatShown('firstToken', true));
    });

    it('adds the live figures to what the earlier runs stored, and their usage until this run reports', () => {
      const stored = message('a1', { content: 'Partial', stats, usage: { outputTokens: 300, creditsUsed: 3 } });
      render([stored], { statsRail: true, streaming: true, liveTurn: turn });

      expect(statValue('thinking')).toBe('5s');
      expect(statValue('firstToken')).toBe('800ms');
      expect(statValue('tokens')).toBe('300');
      // The turn line shows the cost while it runs.
      expect(statValue('cost')).toBeUndefined();

      render([stored], {
        statsRail: true,
        streaming: true,
        liveTurn: { ...turn, usage: { outputTokens: 520, creditsUsed: 5 } },
      });
      expect(statValue('tokens')).toBe('520');
    });

    it('shows no time for a reply stored before stats were kept, only its counts', () => {
      const legacy = message('a1', { content: 'Partial', usage: { outputTokens: 300 } });
      render([legacy], { statsRail: true, streaming: true, liveTurn: turn });

      expect(statValue('thinking')).toBeUndefined();
      expect(statValue('firstToken')).toBeUndefined();
      expect(statValue('tokens')).toBe('300');
    });
  });

  it('keeps the live figures on the reply being written when a queued message lands after it', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(20_000);
    const turn: TurnProgress = { startedAt: 15_000, tokens: null, messageId: 'a1', thinkingSince: 17_000 };

    render(
      [
        message('u1', { role: 'user', content: 'Think hard' }),
        message('a1', { content: 'Working' }),
        message('r1', {
          role: 'user',
          content: 'Done over there',
          relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
        }),
      ],
      { statsRail: true, streaming: true, liveTurn: turn }
    );

    expect(statValue('thinking')).toBe('3s');
  });

  it('switches the live figures for the stored ones when the reply settles', () => {
    const live: TurnProgress = { startedAt: Date.now() - 4000, tokens: null };
    render([message('a1', { content: 'Partial' })], { statsRail: true, streaming: true, liveTurn: live });
    expect(statValue('thinking')).toBeUndefined();

    render([message('a1', { content: 'Done.', stats })], { statsRail: true, streaming: false, liveTurn: null });
    expect(statValue('total')).toBe('12.0s');
    expect(statValue('thinking')).toBe('3.0s');
  });
});

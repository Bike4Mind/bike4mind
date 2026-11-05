// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatReplyStats } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread, railRows } from './MessageThread';
import { REPLY_STATS } from './replyStats';
import { reloadReplyStatsPrefs, setReplyStatShown } from './replyStatsPrefs';
import type { TurnProgress } from './statusLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const statsReads = vi.hoisted(() => ({ byId: {} as Record<string, number> }));

// A reply with the id 'unreadable' has stats that cannot be read, and 'flaky' has live figures that
// cannot, for the rail's error boundary. Reads are counted per reply, for the memo.
vi.mock('./replyStats', async importOriginal => {
  const actual = await importOriginal<typeof import('./replyStats')>();
  return {
    ...actual,
    messageStats: (message: ChatMessage) => {
      statsReads.byId[message.id] = (statsReads.byId[message.id] ?? 0) + 1;
      if (message.id === 'unreadable') throw new Error('unreadable stats');
      return actual.messageStats(message);
    },
    liveReplyStats: (turn: TurnProgress, now: number, earlier?: ChatReplyStats) => {
      if (turn.messageId === 'flaky') throw new Error('unreadable live figures');
      return actual.liveReplyStats(turn, now, earlier);
    },
  };
});

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

describe('railRows', () => {
  const user = (id: string) => message(id, { role: 'user', content: 'Q' });
  const relay = message('r1', {
    role: 'user',
    content: 'Done',
    relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
  });
  const system = message('s1', { role: 'user', content: 'Note', system: true });

  it("runs a rail down its reply's row and the one group of turns after it, up to the next reply", () => {
    const thread = [user('u1'), message('a1'), user('u2'), message('a2'), relay, system, user('u3'), message('a3')];
    expect(railRows(thread, 1, thread.length)).toBe(2);
    expect(railRows(thread, 3, thread.length)).toBe(2);
    expect(railRows(thread, 7, thread.length)).toBe(1);
  });

  it('stops at the end of the list it is drawn in, and at a reply straight after', () => {
    const thread = [message('a1'), message('a2'), user('u1'), user('u2')];
    expect(railRows(thread, 0, thread.length)).toBe(1);
    expect(railRows(thread, 1, thread.length)).toBe(2);
    expect(railRows(thread, 1, 2)).toBe(1);
  });

  it('counts a compaction divider, which is not a reply, in the group', () => {
    const thread = [message('a1'), message('b1', { boundary: { kind: 'compact' } }), user('u1'), message('a2')];
    expect(railRows(thread, 0, thread.length)).toBe(2);
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
    vi.restoreAllMocks();
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

  describe('laid out by the grid, never by measuring', () => {
    const replies = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-message-assistant"]'));
    const cellOf = (id: string) => container.querySelector<HTMLElement>(`[data-rail-for="${id}"]`);
    const thread = [...settled, message('u2', { role: 'user', content: 'And 223?' }), { ...settled[1]!, id: 'a2' }];
    // Rows 126px tall and boxes that never sit still, as fractional display scaling reads them: a
    // spacing measured from these would move the replies, and would never settle.
    const measuredAnywhere = () => {
      let calls = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (calls++ % 3) * 0.4 }) as DOMRect
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.closest('[data-rail-for]') ? 126 : 0;
      });
    };

    it('draws a thread of rails in no more commits than one without, whatever its boxes measure', () => {
      measuredAnywhere();
      const mount = (statsRail: boolean) => {
        const commits = vi.fn();
        const host = document.createElement('div');
        const own = createRoot(host);
        act(() =>
          own.render(
            <Profiler id="thread" onRender={commits}>
              <MessageThread
                messages={thread}
                sessionId="s1"
                streaming={false}
                onRespond={() => undefined}
                onContinue={() => undefined}
                statsRail={statsRail}
              />
            </Profiler>
          )
        );
        const drawn = host.querySelectorAll('[data-testid="chat-reply-stats-rail"]').length;
        act(() => own.unmount());
        return { commits: commits.mock.calls.length, drawn };
      };

      const without = mount(false);
      expect(mount(true)).toEqual({ commits: without.commits, drawn: 2 });
    });

    it('puts each rail in the cell beside its reply and the turns up to the next reply, read after the reply', () => {
      render(thread, { statsRail: true });
      const [a1, a2] = replies();

      expect(cellOf('a1')?.nextElementSibling).toBe(a1);
      expect(cellOf('a1')?.style.gridRow).toBe('span 2');
      expect(cellOf('a2')?.style.gridRow).toBe('span 1');
      expect(a2?.getAttribute('aria-owns')).toBe(cellOf('a2')?.querySelector('[role="group"]')?.id);
      // A rail taller than its rows grows them: the reply keeps the top of its row and the group
      // of turns after it the bottom of its own, so the room opens between a reply and them.
      const column = a1!.parentElement!;
      expect(getComputedStyle(column).display).toBe('grid');
      expect(getComputedStyle(column).rowGap).toBe('24px');
      expect(getComputedStyle(a1!).alignSelf).toBe('start');
      const prompt = container
        .querySelectorAll('[data-testid="chat-message-user"]')[1]!
        .closest<HTMLElement>('[data-testid="chat-turn-group"]')!;
      expect(prompt.parentElement).toBe(column);
      expect(getComputedStyle(prompt).alignSelf).toBe('end');
      expect(getComputedStyle(cellOf('a1')!).gridColumn).toBe('1');
      expect(getComputedStyle(cellOf('a1')!.querySelector('[role="group"]')!).position).toBe('sticky');
    });

    it('keeps three prompts after a short reply in one group, a rail of two rows beside it', () => {
      const prompts = ['u2', 'u3', 'u4'].map(id => message(id, { role: 'user', content: id }));
      render([settled[0]!, settled[1]!, ...prompts, message('a2', { content: 'Next', stats })], { statsRail: true });

      const groups = Array.from(container.querySelectorAll('[data-testid="chat-turn-group"]'));
      expect(groups.map(group => group.querySelectorAll('[data-testid="chat-message-user"]').length)).toEqual([1, 3]);
      expect(cellOf('a1')?.style.gridRow).toBe('span 2');
      expect(cellOf('a2')?.style.gridRow).toBe('span 1');
      expect(groups[1]?.previousElementSibling).toBe(replies()[0]);
      expect(getComputedStyle(groups[1]!.children[1]!).marginTop).toBe('24px');
    });

    it('lays out the folded earlier messages as the same grid', () => {
      render([...thread.slice(0, 2), message('b1', { boundary: { kind: 'compact' } }), ...thread.slice(2)], {
        statsRail: true,
      });
      const details = container.querySelector<HTMLDetailsElement>('[data-testid="chat-earlier-messages"]')!;
      details.open = true;
      act(() => {
        details.dispatchEvent(new Event('toggle'));
      });

      const folded = cellOf('a1')!.parentElement!;
      expect(folded.parentElement).toBe(details);
      expect(getComputedStyle(folded).display).toBe('grid');
      expect(getComputedStyle(folded).rowGap).toBe('24px');
    });

    it('reads a reply to its rail only while the rail is drawn', () => {
      render(
        [
          message('a1', { content: 'No.', stats }),
          message('a2', { content: 'Sure.' }),
          message('a3', { content: 'Done.', stats }),
        ],
        { statsRail: true }
      );
      const [a1, a2, a3] = replies();
      expect(a1?.getAttribute('aria-owns')).toBe(cellOf('a1')?.querySelector('[role="group"]')?.id);
      expect(a2?.hasAttribute('aria-owns')).toBe(false);
      expect(a3?.hasAttribute('aria-owns')).toBe(true);

      act(() => REPLY_STATS.forEach(id => setReplyStatShown(id, false)));
      expect(replies().some(reply => reply.hasAttribute('aria-owns'))).toBe(false);
    });

    it('stops reading a reply to its rail once the rail is unmounted', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render([message('flaky', { content: 'Done.', stats })], { statsRail: true });
      expect(replies()[0]?.hasAttribute('aria-owns')).toBe(true);

      const live: TurnProgress = { startedAt: Date.now() - 4000, tokens: null, messageId: 'flaky' };
      render([message('flaky', { content: 'Working', stats })], { statsRail: true, streaming: true, liveTurn: live });
      expect(cellOf('flaky')).toBeNull();
      expect(replies()[0]?.hasAttribute('aria-owns')).toBe(false);
    });

    it('keeps a group of turns on the same element as the thread grows around it', () => {
      const prompt = message('u2', { role: 'user', content: 'And 223?' });
      const promptGroup = () =>
        Array.from(container.querySelectorAll('[data-testid="chat-turn-group"]')).find(group =>
          group.textContent?.includes('And 223?')
        );
      render([...settled, prompt], { statsRail: true });
      const group = promptGroup();
      expect(group).toBeDefined();

      const reply = message('a2', { content: 'Yes.', stats });
      render([...settled, prompt, reply], { statsRail: true });
      expect(promptGroup()).toBe(group);

      render([...settled, prompt, reply, message('u3', { role: 'user', content: 'x' })], { statsRail: true });
      expect(promptGroup()).toBe(group);

      const older = [message('a0', { content: 'Earlier.', stats }), message('u0', { role: 'user', content: 'z' })];
      render([...older, ...settled, prompt], { statsRail: true });
      expect(promptGroup()).toBe(group);
    });

    it('does not read a reply to a rail that threw', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render([{ ...settled[1]!, id: 'unreadable' }], { statsRail: true });

      expect(replies()[0]?.hasAttribute('aria-owns')).toBe(false);
    });

    it('does not draw a rail again for a reply that did not change', () => {
      const first = message('a1', { content: 'One.', stats });
      const second = message('a2', { content: 'Two.', stats });
      render([first, second], { statsRail: true });
      const reads = { ...statsReads.byId };

      render([first, { ...second, content: 'Two, longer.' }], { statsRail: true });
      expect(statsReads.byId['a1']).toBe(reads['a1']);
      expect(statsReads.byId['a2']).toBeGreaterThan(reads['a2']!);
    });

    it('leaves the live reply where it is when its rail gets its first row', () => {
      measuredAnywhere();
      const live: TurnProgress = { startedAt: Date.now() - 4000, tokens: null, messageId: 'a2' };
      const writing = [...thread.slice(0, 3), message('a2', { content: 'Working' })];
      render(writing, { statsRail: true, streaming: true, liveTurn: live });
      const reply = replies()[1]!;
      const drawn = { className: reply.className, style: reply.getAttribute('style') };
      expect(cellOf('a2')).toBeNull();

      render(writing, {
        statsRail: true,
        streaming: true,
        liveTurn: { ...live, usage: { inputTokens: 900, outputTokens: 30 } },
      });
      expect(cellOf('a2')).not.toBeNull();
      expect(replies()[1]).toBe(reply);
      expect({ className: reply.className, style: reply.getAttribute('style') }).toEqual(drawn);
      expect(cellOf('a1')?.style.gridRow).toBe('span 2');
    });

    it('drops a rail that throws and keeps the thread', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render([...thread.slice(0, 3), { ...settled[1]!, id: 'unreadable', content: 'Still here.' }], {
        statsRail: true,
      });

      expect(replies()[1]?.textContent).toContain('Still here.');
      expect(cellOf('a1')).not.toBeNull();
      expect(cellOf('unreadable')).toBeNull();
      expect(logged).toHaveBeenCalledWith('Reply stats rail failed', expect.any(Error));
    });

    it('draws the rail again from the stored stats after it threw on a live frame', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const live: TurnProgress = { startedAt: Date.now() - 4000, tokens: null, messageId: 'flaky' };
      render([message('flaky', { content: 'Working' })], { statsRail: true, streaming: true, liveTurn: live });
      expect(cellOf('flaky')).toBeNull();

      render([message('flaky', { content: 'Done.', stats })], { statsRail: true, streaming: false, liveTurn: null });
      expect(cellOf('flaky')).not.toBeNull();
      expect(statValue('total')).toBe('12.0s');
    });
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

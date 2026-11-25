// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { buildThread, LARGEST_REAL_SHAPE, STRESS_SHAPE } from './threadFixture';
import { clampWindow, extendWindow, initialWindow, unitsOf, WINDOW_STEP, type ThreadWindow } from './threadWindow';
import {
  collectMatches,
  describeCount,
  findPattern,
  messageScope,
  roundScope,
  stepMatch,
  threadSegments,
  toolScope,
} from './threadFind';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('threadEmptyState', () => {
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

    const render = (sessionId: string | null, emptySession?: ReactNode) =>
      act(() => {
        root.render(
          <MessageThread
            messages={[]}
            sessionId={sessionId}
            noSession={<button data-testid="chat-start-session-btn">New conversation</button>}
            emptySession={emptySession}
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

    it('centers custom setup in place of the ordinary invitation for an empty session', () => {
      render('s1', <form data-testid="workspace-setup">Workspace</form>);
      expect(container.querySelector('[data-testid="workspace-setup"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="chat-thread-empty"]')).toBeNull();
    });
  });
});

describe('threadWindow', () => {
  /** Stored rounds a window draws, counting each message as unitsOf does. */
  function drawnUnits(messages: readonly ChatMessage[], window: ThreadWindow, to = messages.length): number {
    let units = 0;
    for (let index = window.start; index < to; index++) units += unitsOf(messages[index]);
    return units - window.skip;
  }

  function reply(id: string, rounds: number): ChatMessage {
    return {
      id,
      role: 'assistant',
      content: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      rounds: Array.from({ length: rounds }, (_, index) => ({ text: `round ${index}`, toolCallIds: [] })),
    };
  }

  describe('the thread window', () => {
    it('opens the stress fixture on one step of rounds, however long the thread is', () => {
      const messages = buildThread(STRESS_SHAPE);
      const window = initialWindow(messages, 0, messages.length, WINDOW_STEP);

      expect(drawnUnits(messages, window)).toBe(WINDOW_STEP);
      expect(window.start).toBeGreaterThan(messages.length - 10);
    });

    it('ends inside a reply that alone holds more rounds than a step', () => {
      const messages = buildThread(LARGEST_REAL_SHAPE);
      const last = messages.length - 1;

      expect(initialWindow(messages, 0, messages.length, WINDOW_STEP)).toEqual({
        start: last,
        skip: unitsOf(messages[last]) - WINDOW_STEP,
      });
    });

    it('grows by a step each time and stops at the floor', () => {
      const messages = buildThread(STRESS_SHAPE);
      const floor = STRESS_SHAPE.boundaryAt ?? 0;
      let window = initialWindow(messages, floor, messages.length, WINDOW_STEP);
      let steps = 0;
      while (window.start > floor || window.skip > 0) {
        const next = extendWindow(messages, floor, window, WINDOW_STEP);
        expect(drawnUnits(messages, next) - drawnUnits(messages, window)).toBeLessThanOrEqual(WINDOW_STEP);
        expect(next.start).toBeLessThanOrEqual(window.start);
        window = next;
        steps++;
      }

      expect(window).toEqual({ start: floor, skip: 0 });
      expect(steps).toBeGreaterThan(1);
      expect(extendWindow(messages, floor, window, WINDOW_STEP)).toEqual(window);
    });

    it('keeps its top where it was while a reply streams in below it', () => {
      const messages = [reply('a', 30), reply('b', 30)];
      const window = initialWindow(messages, 0, messages.length, WINDOW_STEP);
      const streamed = [...messages, reply('c', 50)];

      expect(window).toEqual({ start: 1, skip: 6 });
      expect(extendWindow(streamed, 0, window, WINDOW_STEP)).toEqual({ start: 0, skip: 12 });
    });

    it('is fitted back inside a range that moved under it', () => {
      expect(clampWindow({ start: 2, skip: 3 }, 5, 10)).toEqual({ start: 5, skip: 0 });
      expect(clampWindow({ start: 12, skip: 3 }, 0, 10)).toEqual({ start: 10, skip: 0 });
      expect(clampWindow({ start: 6, skip: 3 }, 0, 10)).toEqual({ start: 6, skip: 3 });
    });

    it('draws an empty range as complete', () => {
      expect(initialWindow([], 0, 0, WINDOW_STEP)).toEqual({ start: 0, skip: 0 });
    });
  });
});

describe('threadFind', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const call = (id: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
    id,
    name: 'bash_execute',
    input: { command: `grep needle ${id}` },
    status: 'done',
    preview: `needle in ${id} output`,
    ...extra,
  });

  const thread: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Find the Needle please', createdAt: at },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      createdAt: at,
      rounds: [
        { text: 'Looking for needle.', toolCallIds: ['c1'] },
        { text: 'Here:\n```ts\nconst needle = 1;\n```', toolCallIds: [] },
      ],
      toolCalls: [call('c1')],
    },
    {
      id: 'r1',
      role: 'user',
      content: 'relayed needle',
      relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
      createdAt: at,
    },
    {
      id: 'b1',
      role: 'assistant',
      content: 'cleared needle',
      boundary: { kind: 'clear' },
      createdAt: at,
    } as ChatMessage,
    {
      id: 'b2',
      role: 'assistant',
      content: 'summary needle',
      boundary: { kind: 'compact' },
      createdAt: at,
    } as ChatMessage,
    {
      id: 'k1',
      role: 'user',
      content: 'skill body needle',
      skill: { name: 'ship', source: 'account' },
      createdAt: at,
    } as ChatMessage,
  ];

  describe('threadSegments', () => {
    it('collects user text, reply rounds, tool input and output, relays and compact summaries in thread order', () => {
      const segments = threadSegments(thread);
      expect(segments.map(segment => segment.scope)).toEqual([
        messageScope('u1'),
        roundScope('a1', 0),
        toolScope('c1', 'input'),
        toolScope('c1', 'output'),
        roundScope('a1', 1),
        messageScope('r1'),
        messageScope('b2'),
      ]);
      expect(segments.find(segment => segment.scope === toolScope('c1', 'output'))).toMatchObject({
        messageId: 'a1',
        messageIndex: 1,
        callId: 'c1',
        part: 'output',
      });
      // Code blocks are part of a round's text.
      expect(segments.find(segment => segment.scope === roundScope('a1', 1))?.text).toContain('const needle');
    });

    it("leaves out a child's notices, which fold into its card, and keeps one that names no child", () => {
      const notice = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
        id,
        role: 'user',
        system: true,
        content: '[App notice]',
        display: 'A session you started is waiting for you: an approval.',
        createdAt: '2026-11-25T09:00:00.000Z',
        ...extra,
      });
      const scopes = threadSegments([
        notice('w1', { childWaiting: { sessionId: 'child', reason: 'approval' } }),
        notice('rep1', { reportedChildId: 'child' }),
        notice('legacy', {}),
      ]).map(segment => segment.scope);
      expect(scopes).toEqual([messageScope('legacy')]);
    });

    it('leaves out a skill body and a /clear divider, which draw no searchable text', () => {
      const scopes = threadSegments(thread).map(segment => segment.scope);
      expect(scopes).not.toContain(messageScope('k1'));
      expect(scopes).not.toContain(messageScope('b1'));
    });

    it('takes an errored call output from its error, and skips the input of a call that drew a diff', () => {
      const errored: ChatMessage = {
        id: 'a2',
        role: 'assistant',
        content: '',
        createdAt: at,
        rounds: [{ text: '', toolCallIds: ['c2'] }],
        toolCalls: [
          call('c2', {
            error: 'boom needle',
            preview: 'ignored',
            diff: { path: 'a.ts', hunks: [] } as unknown as ChatToolCall['diff'],
          }),
        ],
      };
      const segments = threadSegments([errored]);
      expect(segments.map(segment => [segment.scope, segment.text])).toEqual([
        [toolScope('c2', 'output'), 'boom needle'],
      ]);
    });
  });

  describe('collectMatches', () => {
    const segments = threadSegments(thread);

    it('is case-insensitive by default and counts every occurrence in each segment', () => {
      const matches = collectMatches(segments, 'needle', false);
      expect(matches).toHaveLength(7);
      expect(matches.filter(match => match.scope === toolScope('c1', 'input'))).toHaveLength(1);
      expect(matches[0]).toMatchObject({ scope: messageScope('u1'), occurrence: 0 });
    });

    it('honours the case toggle', () => {
      expect(collectMatches(segments, 'Needle', true).map(match => match.scope)).toEqual([messageScope('u1')]);
    });

    it('numbers repeated occurrences within one segment', () => {
      const repeated = threadSegments([{ id: 'u', role: 'user', content: 'ab ab AB', createdAt: at }]);
      expect(collectMatches(repeated, 'ab', false).map(match => match.occurrence)).toEqual([0, 1, 2]);
    });

    it('treats the query literally, not as a pattern', () => {
      const literal = threadSegments([{ id: 'u', role: 'user', content: 'a.b axb (x)', createdAt: at }]);
      expect(collectMatches(literal, 'a.b', false)).toHaveLength(1);
      expect(collectMatches(literal, '(x)', false)).toHaveLength(1);
    });

    it('finds nothing for an empty query and stops counting at the cap', () => {
      expect(collectMatches(segments, '', false)).toEqual([]);
      expect(findPattern('', false)).toBeNull();
      expect(collectMatches(segments, 'e', false, 3)).toHaveLength(3);
    });
  });

  describe('stepMatch and describeCount', () => {
    it('wraps at both ends', () => {
      expect(stepMatch(2, 3, 1)).toBe(0);
      expect(stepMatch(0, 3, -1)).toBe(2);
      expect(stepMatch(-1, 3, 1)).toBe(0);
      expect(stepMatch(-1, 3, -1)).toBe(2);
      expect(stepMatch(0, 0, 1)).toBe(-1);
    });

    it('says where the bar is, and when the count stopped at the cap', () => {
      expect(describeCount(2, 12)).toBe('3 of 12');
      expect(describeCount(-1, 0)).toBe('No results');
      expect(describeCount(0, 10, 10)).toBe('1 of 10+');
    });
  });
});

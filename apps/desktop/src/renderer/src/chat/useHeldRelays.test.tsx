// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatHeldRelay, ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHeldRelays, type HeldRelaysController } from './useHeldRelays';
import { automaticSummary, displayText, relaySummary, relaySummaryParts } from './relayRows';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useHeldRelays', () => {
  const entry = (id: string, sessionId: string): ChatHeldRelay => ({
    id,
    sessionId,
    text: 'please run the migration',
    relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', hops: 1 },
    heldAt: '2026-10-05T00:00:00.000Z',
    reason: 'other-project',
  });

  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function mount(sessionId: string, initial: ChatHeldRelay[]) {
    let push: (event: ChatStreamEvent) => void = () => {};
    const getHeldRelays = vi.fn(() => Promise.resolve(initial));
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: {
        getHeldRelays,
        resolveHeldRelay: vi.fn(),
        onStreamEvent: (callback: (event: ChatStreamEvent) => void) => {
          push = callback;
          return () => {};
        },
      },
    };
    let controller: HeldRelaysController | null = null;
    function Probe() {
      controller = useHeldRelays(sessionId);
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    return { getHeldRelays, push: (event: ChatStreamEvent) => act(() => push(event)), held: () => controller?.held };
  }

  describe('useHeldRelays', () => {
    it('reads the held messages when the conversation opens', async () => {
      const { getHeldRelays, held } = await mount('s1', [entry('h1', 's1')]);
      expect(getHeldRelays).toHaveBeenCalledWith('s1');
      expect(held()?.map(item => item.id)).toEqual(['h1']);
    });

    it('replaces the list on a push for its own session and ignores another session', async () => {
      const { push, held } = await mount('s1', []);

      push({ type: 'held-relays', sessionId: 's1', held: [entry('h2', 's1')] });
      expect(held()?.map(item => item.id)).toEqual(['h2']);

      push({ type: 'held-relays', sessionId: 'other', held: [entry('h3', 'other')] });
      expect(held()?.map(item => item.id)).toEqual(['h2']);
    });
  });
});

describe('relayRows', () => {
  const from = { fromSessionId: 'abc', fromTitle: 'Docs pass', hops: 1 };

  describe('relaySummary', () => {
    it('names the sender before the message', () => {
      expect(relaySummary({ content: 'render replies as markdown', relay: from })).toBe(
        'Received message from Docs pass: render replies as markdown'
      );
    });

    it('flattens a multi-line message into the one line the row has', () => {
      expect(relaySummary({ content: 'first line\n\nsecond line', relay: from })).toBe(
        'Received message from Docs pass: first line second line'
      );
    });

    it('clips a long message rather than letting it push the chevron off the row', () => {
      const summary = relaySummary({ content: 'x'.repeat(200), relay: from });
      expect(summary).toBe(`Received message from Docs pass: ${'x'.repeat(61)}...`);
    });

    // The sender is still named when the descriptor is missing: a row that says only "Received
    // message" would be indistinguishable from the user's own turn at a glance.
    it('falls back to naming an unknown sender rather than dropping the prefix', () => {
      expect(relaySummary({ content: 'hello' })).toBe('Received message from another session: hello');
    });

    it('is just the header when the message is empty', () => {
      expect(relaySummary({ content: '   ', relay: from })).toBe('Received message from Docs pass');
    });

    it('summarises the user-facing wording, not the model-facing one', () => {
      const summary = relaySummary({
        content: 'The session you started, "XP engine" (e8d8981c-5829-4e70-a20a-8e82370ac565), has finished.',
        display: 'The session "XP engine" has finished.',
        relay: from,
      });
      expect(summary).toBe('Received message from Docs pass: The session "XP engine" has finished.');
    });
  });

  describe('relaySummary variants', () => {
    it('names the sender project when the message came from another one', () => {
      expect(relaySummary({ content: 'hi', relay: { ...from, fromProject: 'docs' } })).toBe(
        'Received message from Docs pass (docs): hi'
      );
      expect(relaySummary({ content: '  ', relay: { ...from, fromProject: 'docs' } })).toBe(
        'Received message from Docs pass (docs)'
      );
    });

    it('reads a done notice as the sender finishing, without the received-message prefix', () => {
      const relay = { ...from, kind: 'done' as const, fromProject: 'docs' };
      expect(relaySummary({ content: 'model-facing text', relay })).toBe(
        'Docs pass finished the turn your message started'
      );
    });

    it('splits around the sender so the name can be a link', () => {
      expect(relaySummaryParts({ content: 'hi', relay: from })).toEqual({
        lead: 'Received message from ',
        sender: 'Docs pass',
        tail: ': hi',
      });
      expect(relaySummaryParts({ content: 'x', relay: { ...from, kind: 'done' } })).toEqual({
        lead: '',
        sender: 'Docs pass',
        tail: ' finished the turn your message started',
      });
    });
  });

  describe('displayText', () => {
    it('prefers the user-facing wording when there is one', () => {
      expect(displayText({ content: 'read it with session_read (abc)', display: 'It has finished.' })).toBe(
        'It has finished.'
      );
    });

    // Messages stored before `display` existed have only the model's copy. Showing it is worse
    // than showing the new wording and far better than an empty row.
    it('falls back to the stored content when no wording was recorded', () => {
      expect(displayText({ content: 'an older report' })).toBe('an older report');
      expect(displayText({ content: 'an older report', display: '   ' })).toBe('an older report');
    });
  });

  describe('automaticSummary', () => {
    it('names auto-fix before what the turn is about', () => {
      const automatic = {
        kind: 'auto-fix' as const,
        prUrl: 'https://github.com/example-org/widgets/pull/611',
        prNumber: 611,
        summary: '1 failing check on #611',
      };
      expect(automaticSummary({ automatic })).toBe('Started by auto-fix: 1 failing check on #611');
    });

    it('says a background command finished rather than crediting auto-fix', () => {
      const automatic = { kind: 'background-exit' as const, processIds: ['a1b2c3d4'], summary: '[a1b2c3d4] exited 0' };
      expect(automaticSummary({ automatic })).toBe('Background command finished: [a1b2c3d4] exited 0');
    });

    it('says the agents finished rather than crediting auto-fix', () => {
      const automatic = { kind: 'agents-settled' as const, sessionIds: ['s1', 's2'], summary: '2 agents: 2 done' };
      expect(automaticSummary({ automatic })).toBe('Agents finished: 2 agents: 2 done');
    });
  });
});

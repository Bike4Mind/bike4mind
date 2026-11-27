// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { ChatHeldRelay, ChatStreamEvent } from '@shared/chat';
import { NeedsYouStrip } from './NeedsYouStrip';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';

let streamListener: ((event: ChatStreamEvent) => void) | null = null;
const chat = {
  getSession: vi.fn(),
  getHeldRelays: vi.fn(),
  resolveHeldRelay: vi.fn(),
  regenerateReply: vi.fn(),
  onStreamEvent: vi.fn((listener: (event: ChatStreamEvent) => void) => {
    streamListener = listener;
    return () => {
      streamListener = null;
    };
  }),
};
const onOpenDetails = vi.fn();
const themed = createThemedMount();

const heldFor = (sessionId: string, id: string): ChatHeldRelay => ({
  id,
  sessionId,
  text: `held ${id}`,
  heldAt: '2026-10-01T00:00:00.000Z',
  reason: 'other-project',
  relay: { fromSessionId: 'x', fromTitle: 'Sender', hops: 1 },
});

const child = agentFixture('c', 'working', { title: 'Child' });
const grandchild = agentFixture('g', 'needs-you', { title: 'Grandchild', parentId: 'c', depth: 2 });
const failed = agentFixture('f', 'failed', { title: 'Failed one' });

const render = (agents: AgentView[]) =>
  themed.render(<NeedsYouStrip agents={agents} personas={new Map()} rootTitle="Quest" onOpenDetails={onOpenDetails} />);

const flush = () => act(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  streamListener = null;
  chat.getSession.mockImplementation(async (id: string) =>
    id === 'f'
      ? {
          messages: [
            { id: 'p', role: 'user', content: 'go', createdAt: '2026-10-01' },
            { id: 'r', role: 'assistant', content: '', error: 'Network down', createdAt: '2026-10-01' },
          ],
        }
      : { messages: [] }
  );
  chat.getHeldRelays.mockImplementation(async (id: string) => (id === 'g' ? [heldFor('g', 'h1')] : []));
  chat.resolveHeldRelay.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
});

afterEach(() => themed.unmount());

describe('NeedsYouStrip', () => {
  it('lists every descendant decision flat, each with the path to who asked', async () => {
    await render([child, grandchild, failed]);
    await flush();
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="decision-card"]')];
    expect(cards.map(card => `${card.dataset.sessionId}:${card.dataset.kind}`)).toEqual(['g:held-relay', 'f:error']);
    expect(el('orchestrator-needs-you-strip-title').textContent).toBe('Needs you (2)');
    expect(cards[0].querySelector('[data-testid="decision-card-path"]')?.textContent).toBe(
      'Quest > Child > Grandchild'
    );
    // A working agent's transcript is never read.
    expect(chat.getSession).not.toHaveBeenCalledWith('c');
  });

  it('resolves a grandchild held relay and drops it on the refetch', async () => {
    await render([child, grandchild]);
    await flush();
    chat.getHeldRelays.mockResolvedValue([]);
    await act(async () => el('held-relay-deliver-btn').click());
    await flush();
    expect(chat.resolveHeldRelay).toHaveBeenCalledWith('g', 'h1', true);
    expect(query('orchestrator-needs-you-strip')).toBeNull();
  });

  it('picks up a held relay pushed while the agent already needs the user, reading only that agent', async () => {
    chat.getHeldRelays.mockResolvedValue([]);
    await render([grandchild, failed]);
    await flush();
    expect(document.querySelector('[data-decision-id="held:h2"]')).toBeNull();
    chat.getHeldRelays.mockClear();
    chat.getSession.mockClear();
    chat.getHeldRelays.mockResolvedValue([heldFor('g', 'h2')]);
    await act(async () => streamListener?.({ type: 'held-relays', sessionId: 'g', held: [heldFor('g', 'h2')] }));
    await flush();
    expect(document.querySelector('[data-decision-id="held:h2"]')).not.toBeNull();
    expect(chat.getHeldRelays.mock.calls).toEqual([['g']]);
    expect(chat.getSession.mock.calls).toEqual([['g']]);
  });

  it('hides what was read under an older state until the refetch lands', async () => {
    await render([grandchild]);
    await flush();
    expect(el('decision-card').dataset.decisionId).toBe('held:h1');
    chat.getHeldRelays.mockReturnValue(new Promise<ChatHeldRelay[]>(() => undefined));
    await render([{ ...grandchild, updatedAt: '2026-10-02T00:00:00.000Z' }]);
    await flush();
    expect(query('decision-card')).toBeNull();
  });

  it('clears a read failure once no agent is waiting', async () => {
    chat.getSession.mockRejectedValue(new Error('disk gone'));
    await render([grandchild]);
    await flush();
    expect(el('orchestrator-needs-you-strip-error').textContent).toBe('disk gone');
    await render([{ ...grandchild, state: 'working' }]);
    await flush();
    expect(query('orchestrator-needs-you-strip')).toBeNull();
  });

  it('uses the persona name the stage gives an agent', async () => {
    const personas = assignPersonas([
      { id: 'g', createdAt: grandchild.createdAt, title: grandchild.title, seedPrompt: grandchild.seedPrompt },
    ]);
    await themed.render(
      <NeedsYouStrip agents={[grandchild]} personas={personas} rootTitle="Quest" onOpenDetails={onOpenDetails} />
    );
    await flush();
    expect(el('decision-card-asker').textContent).toBe(personas.get('g')?.label);
  });

  it('shows a read failure instead of an empty strip', async () => {
    chat.getSession.mockRejectedValue(new Error('disk gone'));
    await render([grandchild]);
    await flush();
    expect(el('orchestrator-needs-you-strip-error').textContent).toBe('disk gone');
  });
});

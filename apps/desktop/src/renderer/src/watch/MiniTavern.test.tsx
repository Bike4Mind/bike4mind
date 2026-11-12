// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniTavernApi } from '@shared/ipc';
import { EMPTY_WATCH_SNAPSHOT, type WatchOrchestration, type WatchPending, type WatchSnapshot } from '@shared/watch';
import { createThemedMount, el, query } from '../chat/orchestrator/testUtils';
import { MiniTavern } from './MiniTavern';

vi.mock('../chat/orchestrator/chime', () => ({ playChime: vi.fn() }));

const room = (rootId: string, extra: Partial<WatchOrchestration> = {}): WatchOrchestration => ({
  rootId,
  title: `Room ${rootId}`,
  agents: [{ id: `${rootId}-a`, title: 'Agent', state: 'working', activity: null }],
  sessions: [],
  statuses: {},
  activity: {},
  lastActiveAt: 0,
  needsYouSince: null,
  celebrate: false,
  ...extra,
});

const pending = (extra: Partial<WatchPending> = {}): WatchPending => ({
  approvalId: 'approval-1',
  sessionId: 'b-a',
  rootId: 'b',
  agentTitle: 'Builder',
  orchestrationTitle: 'Room b',
  summary: 'bash pnpm test',
  quick: true,
  since: 5,
  ...extra,
});

function fakeApi(initial: WatchSnapshot) {
  let listener: ((snapshot: WatchSnapshot) => void) | null = null;
  const api: MiniTavernApi = {
    getSnapshot: vi.fn(async () => initial),
    onSnapshot: vi.fn(next => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    respond: vi.fn(async () => true),
    focusAgent: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const push = async (snapshot: WatchSnapshot) => {
    await act(async () => listener?.(snapshot));
  };
  return { api, push };
}

const themed = createThemedMount();
const click = async (testId: string) => {
  await act(async () => el(testId).click());
};
const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

describe('MiniTavern', () => {
  beforeEach(() => setWindowSize(360, 220));
  afterEach(() => themed.unmount());

  it('shows the room that needs you and its oldest request, answerable in place', async () => {
    const snapshot: WatchSnapshot = {
      ...EMPTY_WATCH_SNAPSHOT,
      overall: 'needs-you',
      needsYouCount: 1,
      orchestrations: [room('a', { lastActiveAt: 10 }), room('b', { needsYouSince: 5 })],
      pending: [pending()],
    };
    const { api } = fakeApi(snapshot);
    await themed.render(<MiniTavern api={api} />);

    expect(el('mini-tavern-title').textContent).toBe('Room b');
    expect(el('mini-tavern-position').textContent).toBe('2 of 2');
    expect(el('mini-needs-you-orchestration').textContent).toBe('Room b');
    expect(el('mini-needs-you-summary').textContent).toBe('bash pnpm test');

    await click('mini-needs-you-approve-btn');
    expect(api.respond).toHaveBeenCalledWith('approval-1', 'once');
    await click('mini-needs-you-deny-btn');
    expect(api.respond).toHaveBeenCalledWith('approval-1', 'deny');
  });

  it('sends a risky request to the app instead of offering approve', async () => {
    const snapshot: WatchSnapshot = {
      ...EMPTY_WATCH_SNAPSHOT,
      orchestrations: [room('b', { needsYouSince: 5 })],
      pending: [pending({ quick: false })],
    };
    const { api } = fakeApi(snapshot);
    await themed.render(<MiniTavern api={api} />);

    expect(query('mini-needs-you-approve-btn')).toBeNull();
    await click('mini-needs-you-review-btn');
    expect(api.focusAgent).toHaveBeenCalledWith('b-a', 'b');
  });

  it('pins a paged room and flags another room that needs you', async () => {
    const calm: WatchSnapshot = {
      ...EMPTY_WATCH_SNAPSHOT,
      orchestrations: [room('a', { lastActiveAt: 10 }), room('b', { lastActiveAt: 5 })],
    };
    const { api, push } = fakeApi(calm);
    await themed.render(<MiniTavern api={api} />);
    expect(el('mini-tavern-title').textContent).toBe('Room a');

    await click('mini-tavern-next-btn');
    expect(el('mini-tavern-title').textContent).toBe('Room b');

    await push({ ...calm, orchestrations: [room('a', { needsYouSince: 20 }), room('b', { lastActiveAt: 5 })] });
    expect(el('mini-tavern-title').textContent).toBe('Room b');
    // A clickable Joy Chip puts its action on an inner button.
    await act(async () => el('mini-tavern-other-room-pill').querySelector('button')?.click());
    expect(el('mini-tavern-title').textContent).toBe('Room a');
  });

  it('drops the pin once the pinned room finishes', async () => {
    const calm: WatchSnapshot = {
      ...EMPTY_WATCH_SNAPSHOT,
      orchestrations: [room('a', { lastActiveAt: 10 }), room('b', { lastActiveAt: 5 })],
    };
    const { api, push } = fakeApi(calm);
    await themed.render(<MiniTavern api={api} />);
    await click('mini-tavern-next-btn');
    expect(el('mini-tavern-title').textContent).toBe('Room b');

    await push({
      ...calm,
      orchestrations: [room('a', { lastActiveAt: 10 }), room('b', { lastActiveAt: 5, celebrate: true })],
    });
    expect(el('mini-tavern-title').textContent).toBe('Room a');
  });

  it('collapses to a strip of state dots when tiny', async () => {
    setWindowSize(240, 56);
    const { api } = fakeApi({ ...EMPTY_WATCH_SNAPSHOT, orchestrations: [room('a'), room('b')] });
    await themed.render(<MiniTavern api={api} />);

    expect(query('mini-tavern-room')).toBeNull();
    await click('mini-strip-cluster-b');
    expect(api.focusAgent).toHaveBeenCalledWith('b', 'b');
  });

  it('closes on Escape', async () => {
    const { api } = fakeApi(EMPTY_WATCH_SNAPSHOT);
    await themed.render(<MiniTavern api={api} />);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

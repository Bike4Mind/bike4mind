import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { apiGetMock, apiPostMock, subscribeToActionMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  subscribeToActionMock: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: apiGetMock, post: apiPostMock },
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: subscribeToActionMock }),
}));

import HearthChannelsView from './HearthChannelsView';

const appTheme = extendTheme({ ...getThemeConfig() });

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <HearthChannelsView />
      </QueryClientProvider>
    </CssVarsProvider>
  );
}

function wireEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ev-1',
    channelId: 'ch-1',
    seq: 1,
    actorId: 'actor-1',
    actorName: 'erik',
    kind: 'message',
    human: { text: 'hello from the log', format: 'md' },
    refs: {},
    createdAt: '2026-07-22T12:00:00Z',
    ...overrides,
  };
}

const NOW = new Date().toISOString();

type WsHandler = (message: unknown) => Promise<void> | void;

/**
 * Every hearth_event subscriber, not just the last one: the view and the nested
 * presence panel both subscribe, and a mock that kept one callback would silently
 * stop delivering events to the view.
 */
let wsHandlers: WsHandler[] = [];
const pushWs = async (message: unknown) => {
  for (const handler of [...wsHandlers]) await handler(message);
};

beforeEach(() => {
  vi.clearAllMocks();
  wsHandlers = [];
  subscribeToActionMock.mockImplementation((_action: string, cb: WsHandler) => {
    wsHandlers.push(cb);
    return () => {
      wsHandlers = wsHandlers.filter(h => h !== cb);
    };
  });
  apiGetMock.mockImplementation(async (url: string) =>
    url.startsWith('/api/hearth/presence')
      ? {
          data: {
            presence: [{ actorId: 'actor-1', actorName: 'erik', state: 'idle', lastSeen: NOW }],
            staleAfterMs: 300000,
          },
        }
      : { data: { channels: [{ id: 'ch-1', name: 'ops', createdAt: '' }] } }
  );
  apiPostMock.mockResolvedValue({ data: { events: [], cursor: 0 } });
});

async function openChannel() {
  renderView();
  const btn = await screen.findByTestId('hearth-channel-btn');
  fireEvent.click(btn);
  await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/hearth/catchup', expect.anything()));
}

describe('HearthChannelsView', () => {
  it('loads channels and fetches the tail on select', async () => {
    apiPostMock.mockResolvedValue({ data: { events: [wireEvent()], cursor: 1 } });
    await openChannel();

    expect(apiPostMock).toHaveBeenCalledWith('/api/hearth/catchup', { channelId: 'ch-1', tail: 100 });
    await screen.findByText('hello from the log');
  });

  it('shows the presence roster above the event stream', async () => {
    await openChannel();

    const panel = await screen.findByTestId('hearth-presence-panel');
    const list = screen.getByTestId('hearth-event-list');
    // DOCUMENT_POSITION_FOLLOWING: the stream comes after the roster, because
    // "who is blocked on me" is the question asked on arrival.
    expect(panel.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByTestId('hearth-presence-row');
  });

  it('merges WS pushes with the HTTP tail, deduping by id', async () => {
    apiPostMock.mockResolvedValue({ data: { events: [wireEvent()], cursor: 1 } });
    await openChannel();
    await screen.findByText('hello from the log');

    // Duplicate of the tail event: must not render twice.
    await pushWs({ action: 'hearth_event', event: wireEvent() });
    // Genuinely new event: must appear.
    await pushWs({
      action: 'hearth_event',
      event: wireEvent({ id: 'ev-2', seq: 2, human: { text: 'second', format: 'md' } }),
    });

    await screen.findByText('second');
    expect(screen.getAllByText('hello from the log')).toHaveLength(1);
  });

  it('filters WS events from other channels out of the view', async () => {
    await openChannel();

    await pushWs({
      action: 'hearth_event',
      event: wireEvent({ id: 'ev-x', channelId: 'ch-OTHER', human: { text: 'foreign', format: 'md' } }),
    });

    await waitFor(() => {
      expect(screen.queryByText('foreign')).toBeNull();
    });
  });

  it('renders events in seq order even when pushes arrive out of order', async () => {
    await openChannel();

    await pushWs({
      action: 'hearth_event',
      event: wireEvent({ id: 'ev-3', seq: 3, human: { text: 'third', format: 'md' } }),
    });
    await pushWs({
      action: 'hearth_event',
      event: wireEvent({ id: 'ev-2', seq: 2, human: { text: 'second', format: 'md' } }),
    });

    await screen.findByText('third');
    const list = screen.getByTestId('hearth-event-list');
    const order = Array.from(list.querySelectorAll('p, span'))
      .map(n => n.textContent)
      .filter(t => t === 'second' || t === 'third');
    expect(order).toEqual(['second', 'third']);
  });

  it('colors each actor from a hash of actorId, so the color survives reordering', async () => {
    apiPostMock.mockResolvedValue({
      data: {
        events: [
          wireEvent({ id: 'a1', seq: 1, actorId: 'actor-1', actorName: 'erik' }),
          wireEvent({ id: 'b1', seq: 2, actorId: 'actor-2', actorName: 'spock' }),
          wireEvent({ id: 'a2', seq: 3, actorId: 'actor-1', actorName: 'erik' }),
        ],
        cursor: 3,
      },
    });
    await openChannel();
    await waitFor(() => expect(screen.getAllByTestId('hearth-event-actor-swatch')).toHaveLength(3));

    const colors = screen.getAllByTestId('hearth-event-actor-swatch').map(n => getComputedStyle(n).backgroundColor);
    // Guard against a vacuous pass: if jsdom stops resolving the emotion rule
    // every color becomes '' and the equality assertions below mean nothing.
    expect(colors.every(c => c.length > 0)).toBe(true);
    // Same actor in rows 1 and 3 (different arrival positions) shares one color;
    // index-derived color would have given all three different colors.
    expect(colors[0]).toBe(colors[2]);
    expect(colors[0]).not.toBe(colors[1]);
  });

  it('keeps name and kind chips as non-color signals on every event', async () => {
    apiPostMock.mockResolvedValue({ data: { events: [wireEvent({ actorKind: 'agent' })], cursor: 1 } });
    await openChannel();

    // The kind chip renders even for 'message' - color is never the only signal.
    expect(await screen.findByTestId('hearth-event-kind-chip')).toHaveTextContent('message');
    expect(screen.getByTestId('hearth-event-actor-name')).toHaveTextContent('erik');
    expect(screen.getByTestId('hearth-event-actor-kind-chip')).toHaveTextContent('Agent');
  });

  it('badges the actor kind so a human-looking name cannot pass for the account owner', async () => {
    apiPostMock.mockResolvedValue({
      data: { events: [wireEvent({ actorKind: 'agent', actorName: 'erik' })], cursor: 1 },
    });
    await openChannel();

    expect(await screen.findByTestId('hearth-event-actor-kind-chip')).toHaveTextContent('Agent');
  });

  it('leaves the actor name in normal ink - two palette slots are sub-3:1 on the light surface', async () => {
    apiPostMock.mockResolvedValue({ data: { events: [wireEvent()], cursor: 1 } });
    await openChannel();

    const swatch = await screen.findByTestId('hearth-event-actor-swatch');
    const name = screen.getByTestId('hearth-event-actor-name');
    expect(getComputedStyle(name).color).not.toBe(getComputedStyle(swatch).backgroundColor);
  });

  it('dedupes the optimistic post against its own WS echo', async () => {
    await openChannel();

    const posted = wireEvent({ id: 'ev-9', seq: 9, human: { text: 'posted!', format: 'md' } });
    apiPostMock.mockResolvedValueOnce({ data: { event: posted } });

    // Joy Input renders the testid on a wrapper; the native input is inside it.
    const composer = screen.getByTestId('hearth-composer-input').querySelector('input');
    fireEvent.change(composer!, { target: { value: 'posted!' } });
    fireEvent.click(screen.getByTestId('hearth-composer-send-btn'));
    await screen.findByText('posted!');

    // The WS echo of the same append arrives after the HTTP response.
    await pushWs({ action: 'hearth_event', event: posted });

    await waitFor(() => {
      expect(screen.getAllByText('posted!')).toHaveLength(1);
    });
  });
  // The `hearth` gear unlocks on owning >= 1 channel, so THIS request is what
  // earns the reveal - but useGearsStatus caches for 5 minutes, so without an
  // explicit invalidation the sidenav row the user just earned stays hidden for
  // up to that long. Now that the row fails closed, hidden is the default.
  it('invalidates the gears status after creating a channel, so the reveal is not stale', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The helper only invalidates while the gear is still LOCKED, so the cache
    // has to hold that state or the call correctly no-ops and proves nothing.
    queryClient.setQueryData(['gears', 'status'], { gears: [{ key: 'hearth', unlocked: false }] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={queryClient}>
          <HearthChannelsView />
        </QueryClientProvider>
      </CssVarsProvider>
    );

    apiPostMock.mockResolvedValueOnce({ data: { channel: { id: 'ch-2', name: 'ops2' } } });
    // Joy Input renders the testid on a wrapper; the native input is inside it.
    const nameInput = (await screen.findByTestId('hearth-new-channel-input')).querySelector('input');
    fireEvent.change(nameInput!, { target: { value: 'ops2' } });
    fireEvent.click(screen.getByTestId('hearth-create-channel-btn'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/hearth/channels', { name: 'ops2' }));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['gears', 'status'] }))
    );
  });

  it('does not invalidate the gears status once the gear is already unlocked', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['gears', 'status'], { gears: [{ key: 'hearth', unlocked: true }] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <CssVarsProvider theme={appTheme}>
        <QueryClientProvider client={queryClient}>
          <HearthChannelsView />
        </QueryClientProvider>
      </CssVarsProvider>
    );

    apiPostMock.mockResolvedValueOnce({ data: { channel: { id: 'ch-2', name: 'ops2' } } });
    // Joy Input renders the testid on a wrapper; the native input is inside it.
    const nameInput = (await screen.findByTestId('hearth-new-channel-input')).querySelector('input');
    fireEvent.change(nameInput!, { target: { value: 'ops2' } });
    fireEvent.click(screen.getByTestId('hearth-create-channel-btn'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/hearth/channels', { name: 'ops2' }));
    // Every subsequent channel would otherwise re-fetch the whole gears catalog.
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['gears', 'status'] }));
  });
});

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

import HearthChannelsView, { actorColorIndex } from './HearthChannelsView';

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

  it('keeps name and kind chip as non-color signals on every event', async () => {
    apiPostMock.mockResolvedValue({ data: { events: [wireEvent()], cursor: 1 } });
    await openChannel();

    // The kind chip renders even for 'message' - color is never the only signal.
    expect(await screen.findByTestId('hearth-event-kind-chip')).toHaveTextContent('message');
    expect(screen.getByTestId('hearth-event-actor-name')).toHaveTextContent('erik');
  });

  it('actorColorIndex is deterministic and stays inside the fixed palette', () => {
    expect(actorColorIndex('actor-1')).toBe(actorColorIndex('actor-1'));
    for (const id of ['a', 'actor-1', '6540b58d1f703ade3ea1e82c', '']) {
      expect(actorColorIndex(id)).toBeGreaterThanOrEqual(0);
      expect(actorColorIndex(id)).toBeLessThan(6);
    }
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
});

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

/** The WS handler captured from subscribeToAction so tests can push events. */
let pushWs: (message: unknown) => Promise<void> | void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  subscribeToActionMock.mockImplementation((_action: string, cb: typeof pushWs) => {
    pushWs = cb;
    return () => {};
  });
  apiGetMock.mockResolvedValue({ data: { channels: [{ id: 'ch-1', name: 'ops', createdAt: '' }] } });
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { apiGetMock, subscribeToActionMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  subscribeToActionMock: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGetMock } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: subscribeToActionMock }),
}));

import HearthPresencePanel from './HearthPresencePanel';

const appTheme = extendTheme({ ...getThemeConfig() });

/** The WS handler captured from subscribeToAction so tests can push events. */
let pushWs: (message: unknown) => Promise<void> | void = () => {};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <HearthPresencePanel channelId="ch-1" />
      </QueryClientProvider>
    </CssVarsProvider>
  );
}

function row(actorId: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    actorId,
    actorName: actorId,
    state,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

const respondWith = (presence: unknown[]) => ({ data: { presence, staleAfterMs: 300000 } });

beforeEach(() => {
  vi.clearAllMocks();
  subscribeToActionMock.mockImplementation((_action: string, cb: typeof pushWs) => {
    pushWs = cb;
    return () => {};
  });
  apiGetMock.mockResolvedValue(respondWith([]));
});

describe('HearthPresencePanel', () => {
  it('fetches the roster for its channel', async () => {
    renderPanel();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/hearth/presence?channelId=ch-1'));
    await screen.findByTestId('hearth-presence-empty');
  });

  it('renders rows in the order the server returned, without re-sorting', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        // Deliberately NOT in lastSeen order: a client-side sort would move the
        // blocked actor off the top, which is the whole point of the roster.
        row('blocked', 'awaiting_input', { lastSeen: '2026-07-27T10:00:05Z' }),
        row('busy', 'working', { lastSeen: '2026-07-27T10:00:20Z' }),
        row('done', 'idle', { lastSeen: '2026-07-27T10:00:30Z' }),
      ])
    );
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('hearth-presence-row')).toHaveLength(3));
    const names = screen.getAllByTestId('hearth-presence-actor-name').map(n => n.textContent);
    expect(names).toEqual(['blocked', 'busy', 'done']);
  });

  it('states are readable as text, not color alone', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([row('blocked', 'awaiting_input'), row('busy', 'working'), row('done', 'idle')])
    );
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('hearth-presence-state-chip')).toHaveLength(3));
    expect(screen.getAllByTestId('hearth-presence-state-chip').map(c => c.textContent)).toEqual([
      'Needs you',
      'Working',
      'Idle',
    ]);
  });

  it('shows workspace, tool, and a relative last-seen when present', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        row('blocked', 'awaiting_input', { workspace: 'some-repo', tool: 'Bash', reason: 'permission_prompt' }),
      ])
    );
    renderPanel();

    expect(await screen.findByTestId('hearth-presence-workspace')).toHaveTextContent('some-repo');
    expect(screen.getByTestId('hearth-presence-tool')).toHaveTextContent('Bash');
    expect(screen.getByTestId('hearth-presence-reason')).toHaveTextContent('permission_prompt');
    expect(screen.getByTestId('hearth-presence-last-seen')).toHaveTextContent('just now');
  });

  it('refreshes on a presence event for its channel', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'working')]));
    renderPanel();
    await screen.findByText('Working');

    apiGetMock.mockResolvedValue(respondWith([row('busy', 'awaiting_input')]));
    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'presence' } });

    await screen.findByText('Needs you');
  });

  it('ignores events from other channels and other kinds', async () => {
    renderPanel();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));

    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-OTHER', kind: 'presence' } });
    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'message' } });

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
  });
});

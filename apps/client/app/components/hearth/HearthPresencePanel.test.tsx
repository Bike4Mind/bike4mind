import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        row('blocked', 'awaiting_permission', { lastSeen: '2026-07-27T10:00:05Z' }),
        row('busy', 'running', { lastSeen: '2026-07-27T10:00:20Z' }),
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
      respondWith([row('blocked', 'awaiting_permission'), row('busy', 'running'), row('done', 'idle')])
    );
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('hearth-presence-state-chip')).toHaveLength(3));
    // Distinct wording per state: a halted session and a session asking a
    // question call for different responses, so the chip must not blur them.
    expect(screen.getAllByTestId('hearth-presence-state-chip').map(c => c.textContent)).toEqual([
      'Needs permission',
      'Working',
      'Idle',
    ]);
  });

  it('badges the actor kind on every row, so color is never the only identity signal', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        // A session-derived human and an agent that named itself after one: the
        // badge is what tells them apart, since the names cannot.
        row('erik', 'running', { actorKind: 'human' }),
        row('erik', 'running', { actorKind: 'agent' }),
      ])
    );
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('hearth-presence-actor-kind-chip')).toHaveLength(2));
    expect(screen.getAllByTestId('hearth-presence-actor-kind-chip').map(c => c.textContent)).toEqual([
      'Human',
      'Agent',
    ]);
  });

  it('shows workspace, tool, and a relative last-seen when present', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        row('blocked', 'awaiting_permission', { workspace: 'some-repo', tool: 'Bash', reason: 'permission_prompt' }),
      ])
    );
    renderPanel();

    expect(await screen.findByTestId('hearth-presence-workspace')).toHaveTextContent('some-repo');
    expect(screen.getByTestId('hearth-presence-tool')).toHaveTextContent('Bash');
    expect(screen.getByTestId('hearth-presence-reason')).toHaveTextContent('permission_prompt');
    expect(screen.getByTestId('hearth-presence-last-seen')).toHaveTextContent('just now');
  });

  it('refreshes on a presence event for its channel', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'running')]));
    renderPanel();
    await screen.findByText('Working');

    apiGetMock.mockResolvedValue(respondWith([row('busy', 'awaiting_permission')]));
    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'presence' } });

    await screen.findByText('Needs permission');
  });

  it('ignores events from other channels and other kinds', async () => {
    renderPanel();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));

    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-OTHER', kind: 'presence' } });
    await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'message' } });

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
  });
  // The four cases below all carry comments in the component asserting they
  // matter, and none of them were exercised.

  it('a failed load says so, and never claims the channel is empty', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderPanel();

    expect(await screen.findByTestId('hearth-presence-error')).toBeInTheDocument();
    // The distinction is the whole point: "nobody is here" is a claim about the
    // world, and a 500 is not evidence for it. With retry: false and no refetch
    // on focus, that wrong claim used to be permanent.
    expect(screen.queryByTestId('hearth-presence-empty')).not.toBeInTheDocument();
  });

  it('a failed load can be retried, since nothing else will', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('boom'));
    renderPanel();

    const retry = await screen.findByTestId('hearth-presence-retry-btn');
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'running')]));
    fireEvent.click(retry);

    await screen.findByText('Working');
    expect(screen.queryByTestId('hearth-presence-error')).not.toBeInTheDocument();
  });

  it('an unknown state falls back to Working rather than to the top of the roster', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('mystery', 'ascended')]));
    renderPanel();

    // Guessing at a state must never escalate: an unrecognized value renders as
    // the neutral working case, not as a claim on the human's attention.
    expect(await screen.findByTestId('hearth-presence-state-chip')).toHaveTextContent('Working');
  });

  it('dims a stale row without dimming the timestamp that explains why', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        // staleAfterMs is 300000, so this row is well past it.
        row('old', 'idle', { lastSeen: new Date(Date.now() - 45 * 60 * 1000).toISOString() }),
      ])
    );
    renderPanel();

    const rowEl = await screen.findByTestId('hearth-presence-row');
    expect(rowEl).toHaveStyle({ opacity: '0.7' });
    // Not 0.6: multiplied by the row's dim that gave ~0.36, below AA, on the one
    // element carrying the staleness information.
    expect(screen.getByTestId('hearth-presence-last-seen')).toHaveStyle({ opacity: '1' });
    expect(screen.getByTestId('hearth-presence-last-seen')).toHaveTextContent('45m ago');
  });

  it('a fresh row leaves the timestamp de-emphasized', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'running')]));
    renderPanel();

    await screen.findByText('Working');
    expect(screen.getByTestId('hearth-presence-row')).toHaveStyle({ opacity: '1' });
    expect(screen.getByTestId('hearth-presence-last-seen')).toHaveStyle({ opacity: '0.6' });
  });

  it('caps its own height so the roster cannot crowd out the composer', async () => {
    renderPanel();
    // Rows are permanent and per-session, so without this the panel grows without
    // bound and the event stream - the only shrinkable child of the column -
    // absorbs all of it until the composer is clipped out of the viewport.
    const panel = await screen.findByTestId('hearth-presence-panel');
    expect(panel).toHaveStyle({ overflowY: 'auto' });
    expect(getComputedStyle(panel).maxHeight).toBe('30dvh');
  });
  it('announces only the sessions that need a human, not the busy ones', async () => {
    apiGetMock.mockResolvedValue(
      respondWith([
        row('blocked', 'awaiting_permission'),
        row('asking', 'awaiting_input'),
        row('busy', 'running'),
        row('done', 'idle'),
      ])
    );
    renderPanel();

    const announcer = await screen.findByTestId('hearth-presence-announcer');
    await waitFor(() => expect(announcer).toHaveTextContent('2 sessions need attention'));
    expect(announcer).toHaveTextContent('blocked needs permission');
    expect(announcer).toHaveTextContent('asking needs you');
    // A roster of several sessions each reporting per tool call would otherwise
    // bury the one actionable line in a stream of "is working".
    expect(announcer).not.toHaveTextContent('busy');
    expect(announcer).not.toHaveTextContent('done');
  });

  it('says nothing when nobody needs attention', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'running')]));
    renderPanel();

    await screen.findByText('Working');
    expect(screen.getByTestId('hearth-presence-announcer')).toHaveTextContent('');
  });

  it('uses singular phrasing for one session', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('blocked', 'awaiting_permission')]));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('hearth-presence-announcer')).toHaveTextContent('1 session needs attention')
    );
  });

  it('exposes the roster as a labelled list with a real heading', async () => {
    apiGetMock.mockResolvedValue(respondWith([row('busy', 'running'), row('done', 'idle')]));
    renderPanel();

    // The heading renders in every state including loading, so wait for the rows
    // before asserting the list - otherwise this races the query.
    await waitFor(() => expect(screen.getAllByTestId('hearth-presence-row')).toHaveLength(2));
    // Joy's title-sm maps to <p>, so the panel had no landmark to navigate to.
    const heading = screen.getByRole('heading', { name: 'Who is here' });
    const list = screen.getByRole('list');
    expect(list).toHaveAttribute('aria-labelledby', heading.id);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // The timer leak. Arming a refresh on one channel and switching before the
  // coalesce window closes used to invalidate the OLD key, swallowing one refresh
  // for the channel just switched to.
  it('does not let a pending refresh fire against the previous channel', async () => {
    vi.useFakeTimers();
    try {
      apiGetMock.mockResolvedValue(respondWith([row('busy', 'running')]));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const view = render(
        <CssVarsProvider theme={appTheme}>
          <QueryClientProvider client={queryClient}>
            <HearthPresencePanel channelId="ch-1" />
          </QueryClientProvider>
        </CssVarsProvider>
      );

      // Two events inside the window: the first refreshes on the leading edge,
      // the second arms the trailing timer.
      await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'presence' } });
      await pushWs({ action: 'hearth_event', event: { channelId: 'ch-1', kind: 'presence' } });

      invalidateSpy.mockClear();
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <QueryClientProvider client={queryClient}>
            <HearthPresencePanel channelId="ch-2" />
          </QueryClientProvider>
        </CssVarsProvider>
      );
      vi.advanceTimersByTime(2000);

      const staleInvalidations = invalidateSpy.mock.calls.filter(
        ([arg]) =>
          JSON.stringify((arg as { queryKey: unknown }).queryKey) === JSON.stringify(['hearth', 'presence', 'ch-1'])
      );
      expect(staleInvalidations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

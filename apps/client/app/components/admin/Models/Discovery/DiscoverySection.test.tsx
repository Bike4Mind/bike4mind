import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MODEL_LIST_REVISION_MEMO_MS } from '@bike4mind/common';
import {
  CRON_RUN,
  DELEGATE,
  FULL_ADMIN,
  STATUS,
  apiError,
  listOf,
  makeWrapper,
  newQueryClient,
  runLike,
  statusWith,
} from './__tests__/discoveryTestKit';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
  nav: { openModel: vi.fn(), openRun: vi.fn(), openSection: vi.fn(), openPrices: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => m.get(...a), post: (...a: unknown[]) => m.post(...a) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('../modelsNavigation', () => ({ useModelsNavigation: () => m.nav }));
vi.mock('sonner', () => ({ toast: m.toast }));
// Each fetches its own endpoints and has its own suite; stubbed so this file's api.get assertions see only status.
vi.mock('./LifecycleSuggestions', () => ({ LifecycleSuggestions: () => null }));
vi.mock('./StaleReferencesPanel', () => ({ StaleReferencesPanel: () => null }));

import { DiscoverySection } from './DiscoverySection';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, useRunNowStore } from './runDiscoveryNow';
import { DISCOVERY_STATUS_QUERY_KEY } from './discoveryApi';

let queryClient = newQueryClient();

const renderSection = () => render(<DiscoverySection />, { wrapper: makeWrapper(queryClient) });

const runNowButton = () => screen.getByTestId('discovery-run-now-btn');

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = newQueryClient();
  m.currentUser = FULL_ADMIN;
  useRunNowStore.setState({ phase: 'idle', notice: null, error: null });
  m.get.mockResolvedValue({ data: STATUS });
  m.post.mockResolvedValue({ data: { dispatched: 'lambda' } });
});

describe('DiscoverySection status', () => {
  it('states the switch, mode, new-model policy and last run in plain words', async () => {
    renderSection();

    const line = await screen.findByTestId('discovery-status-line');
    expect(line).toHaveTextContent('On | Writes changes | New models listed when priced | Last run');
    expect(line).toHaveTextContent('2 of 3 sources ok');
    expect(screen.getByTestId('discovery-status-failures')).toHaveTextContent('models.dev (ETIMEDOUT)');
    expect(screen.getByTestId('discovery-status-schedule')).toHaveTextContent('Last successful run');
  });

  it.each([
    ['report', 'manual', 'Report only | New models wait for approval'],
    ['write', 'all', 'Writes changes | New models listed automatically'],
  ])('words mode %s and policy %s for people, not as enum values', async (mode, autoEnable, expected) => {
    m.get.mockResolvedValue({ data: { ...STATUS, mode, autoEnable } });
    renderSection();

    expect(await screen.findByTestId('discovery-status-line')).toHaveTextContent(expected);
  });

  it('names skipped sources apart from the attempt tally', async () => {
    const lastRun = runLike({ skippedSources: [{ name: 'xai', reason: 'not-configured' }] });
    m.get.mockResolvedValue({ data: statusWith(lastRun) });
    renderSection();

    expect(await screen.findByTestId('discovery-status-line')).toHaveTextContent('2 of 3 sources ok');
    expect(screen.getByTestId('discovery-status-skipped')).toHaveTextContent('xai (not configured)');
  });

  it('says a run attempted nothing rather than 0 of 0 when every source was skipped', async () => {
    const lastRun = runLike({ sources: [], skippedSources: [{ name: 'openai', reason: 'egress-disabled' }] });
    m.get.mockResolvedValue({ data: statusWith(lastRun) });
    renderSection();

    expect(await screen.findByTestId('discovery-status-line')).toHaveTextContent('no sources attempted');
    expect(screen.getByTestId('discovery-status-skipped')).toHaveTextContent('openai (outbound calls are off)');
  });

  it('projects the next scheduled run from the last one, and stays quiet when the schedule looks stopped', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    m.get.mockResolvedValue({ data: statusWith(runLike({ startedAt: twoHoursAgo })) });
    const { unmount } = renderSection();
    expect(await screen.findByTestId('discovery-status-schedule')).toHaveTextContent('Next scheduled run about');
    unmount();

    queryClient = newQueryClient();
    const yesterday = new Date(Date.now() - 13 * 3600_000).toISOString();
    m.get.mockResolvedValue({ data: statusWith(runLike({ startedAt: yesterday })) });
    renderSection();
    expect(await screen.findByTestId('discovery-status-schedule')).not.toHaveTextContent('Next scheduled run');
  });

  it('links to the discovery settings', async () => {
    renderSection();
    fireEvent.click(await screen.findByTestId('discovery-settings-link'));

    expect(m.nav.openSection).toHaveBeenCalledWith('settings');
  });

  it('shows the off state with a way to settings, and no Run now', async () => {
    m.get.mockResolvedValue({ data: { ...STATUS, enabled: false } });
    renderSection();

    const off = await screen.findByTestId('discovery-off');
    expect(off).toHaveTextContent('Discovery is off');
    expect(off).toHaveTextContent('Turn it on to check providers for new models every 6 hours.');
    expect(screen.queryByTestId('discovery-run-now-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('discovery-open-settings-btn'));
    expect(m.nav.openSection).toHaveBeenCalledWith('settings');
  });

  it('offers Run now in the empty run list when discovery has never run', async () => {
    m.get.mockResolvedValue({ data: statusWith(null, { lastSuccessfulRunAt: null }) });
    renderSection();

    expect(await screen.findByTestId('discovery-status-line')).toHaveTextContent('Never run');
    const empty = screen.getByTestId('discovery-runs-empty');
    expect(empty).toHaveTextContent('No runs yet');
    expect(within(empty).getByTestId('discovery-runs-empty-run-now-btn')).toBeInTheDocument();
  });

  it('reports a failed status read with the server reason and a retry', async () => {
    m.get.mockRejectedValueOnce(apiError(403, { error: 'Missing permission: support:read' }));
    renderSection();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Missing permission: support:read');
    m.get.mockResolvedValue({ data: STATUS });
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('discovery-status-line')).toBeInTheDocument();
  });

  it('keeps the loaded status with a warning when a refresh fails', async () => {
    renderSection();
    await screen.findByTestId('discovery-status-line');

    m.get.mockRejectedValueOnce(apiError(500, { error: 'Database unavailable' }));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: DISCOVERY_STATUS_QUERY_KEY });
    });

    expect(await screen.findByTestId('discovery-status-refresh-error')).toHaveTextContent('Database unavailable');
    expect(screen.getByTestId('discovery-status-line')).toBeInTheDocument();
  });

  it('keeps Run now visible but disabled, with the reason, for an admin who cannot make model writes', async () => {
    m.currentUser = DELEGATE;
    renderSection();

    await screen.findByTestId('discovery-status-line');
    expect(runNowButton()).toBeDisabled();
    expect(screen.getByTestId('models-write-blocked-action')).toContainElement(runNowButton());
  });
});

describe('DiscoverySection run history', () => {
  it('lists runs with when, trigger, result and summary, and opens a run on click', async () => {
    const reportRun = {
      ...listOf(runLike({ id: 'run-0', status: 'ok' })),
      startedAt: '2026-07-25T06:00:00.000Z',
      mode: 'report' as const,
      changes: { added: 1, promoted: 0, deprecated: 0, repriced: 0, flagged: 0 },
    };
    m.get.mockResolvedValue({ data: { ...STATUS, runs: [listOf(CRON_RUN), reportRun] } });
    renderSection();

    const row = await screen.findByTestId('discovery-run-row-run-1');
    expect(row).toHaveTextContent('Scheduled');
    expect(row).toHaveTextContent('Finished, some sources failed');
    expect(row).toHaveTextContent('2 new models, 1 listed');
    const report = screen.getByTestId('discovery-run-row-run-0');
    expect(report).toHaveTextContent('Report only');
    expect(report).toHaveTextContent('1 new model (not saved)');

    fireEvent.click(report);
    expect(m.nav.openRun).toHaveBeenCalledWith('run-0');
  });

  it('states how long runs are kept and where their decisions live', async () => {
    renderSection();

    expect(await screen.findByTestId('discovery-retention-note')).toHaveTextContent(
      'Runs are kept for 90 days. Decisions they raised stay on each model.'
    );
  });
});

describe('DiscoverySection Run now', () => {
  const manualRunning = runLike({ startedAt: '2026-07-26T12:10:00.000Z', finishedAt: null, trigger: 'manual' });
  const manualDone = runLike({
    ...manualRunning,
    id: 'run-manual',
    finishedAt: '2026-07-26T12:12:00.000Z',
    status: 'ok',
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mount, settle the first load, click Run now and settle the dispatch. */
  const mountAndDispatch = async () => {
    const view = renderSection();
    await tick();
    fireEvent.click(runNowButton());
    await tick();
    return view;
  };

  it('polls until the manual run reports, then opens its run page', async () => {
    m.get
      .mockResolvedValueOnce({ data: STATUS }) // mount
      .mockResolvedValueOnce({ data: STATUS }) // baseline re-read before the POST
      .mockResolvedValueOnce({ data: STATUS }) // poll 1: nothing yet
      .mockResolvedValueOnce({ data: statusWith(manualRunning) })
      .mockResolvedValue({ data: statusWith(manualDone) });

    await mountAndDispatch();
    expect(m.post).toHaveBeenCalledWith('/api/admin/model-discovery');
    expect(screen.getByTestId('discovery-run-now-notice')).toHaveTextContent('Run started');

    await tick(POLL_INTERVAL_MS);
    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).not.toHaveBeenCalled();
    expect(runNowButton()).toBeDisabled();

    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).toHaveBeenCalledWith('run-manual');
    expect(runNowButton()).not.toBeDisabled();
  });

  it('refetches the model list and lifecycle queue on completion, and open pickers after the server memo', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    m.get
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusWith(manualDone) });

    await mountAndDispatch();
    expect(invalidate).not.toHaveBeenCalled();

    await tick(POLL_INTERVAL_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'models'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'model-deprecation-status', 'queue'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['admin', 'model-deprecation-status'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['admin', 'model-deprecation-status', 'references'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['llm', 'models'] });

    // Held for the server-side revision memo, so a chat sent from the new list is accepted.
    await tick(MODEL_LIST_REVISION_MEMO_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'models'] });
  });

  it('stays disabled for the whole dispatch-and-wait window, so one click is one dispatch', async () => {
    await mountAndDispatch();

    expect(runNowButton()).toBeDisabled();
    await tick(POLL_INTERVAL_MS * 3);
    expect(runNowButton()).toBeDisabled();
    fireEvent.click(runNowButton());
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it('gives up after two minutes and says another run may hold it when no run appeared', async () => {
    await mountAndDispatch();
    await tick(POLL_TIMEOUT_MS);

    expect(screen.getByTestId('discovery-run-now-notice')).toHaveTextContent('Another run may already be in progress');
    expect(runNowButton()).not.toBeDisabled();
  });

  it('blames the switch instead when discovery was turned off mid-wait', async () => {
    m.get
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: { ...STATUS, enabled: false } });
    await mountAndDispatch();
    await tick(POLL_TIMEOUT_MS);

    expect(useRunNowStore.getState().notice).toContain('Discovery is off');
  });

  it('re-reads the baseline before dispatching, so a run started before the click is not claimed', async () => {
    const earlierManual = runLike({ startedAt: '2026-07-26T12:05:00.000Z', trigger: 'manual', id: 'run-earlier' });
    m.get
      .mockResolvedValueOnce({ data: STATUS }) // mount: the cron run
      .mockResolvedValueOnce({ data: statusWith(earlierManual) }) // baseline: someone else's manual run landed
      .mockResolvedValueOnce({ data: statusWith(earlierManual) })
      .mockResolvedValue({ data: statusWith(manualDone) });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).not.toHaveBeenCalled();
    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).toHaveBeenCalledWith('run-manual');
  });

  it('ignores a cron run that lands mid-wait and keeps waiting for the manual one', async () => {
    const cronMidWait = runLike({ startedAt: '2026-07-26T12:08:00.000Z', id: 'run-cron-2' });
    m.get
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: statusWith(cronMidWait) })
      .mockResolvedValue({ data: statusWith(manualDone) });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).not.toHaveBeenCalled();
    await tick(POLL_INTERVAL_MS);
    expect(m.nav.openRun).toHaveBeenCalledWith('run-manual');
  });

  it('rides out two failed polls and reports the run that arrives on the third', async () => {
    m.get
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockRejectedValueOnce(new Error('flaky'))
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue({ data: statusWith(manualDone) });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS * 3);

    expect(m.nav.openRun).toHaveBeenCalledWith('run-manual');
    expect(screen.queryByTestId('discovery-run-now-error')).not.toBeInTheDocument();
  });

  it('stops waiting once three polls fail in a row', async () => {
    m.get
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockRejectedValue(new Error('status read down'));

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS * 3);

    expect(screen.getByTestId('discovery-run-now-error')).toHaveTextContent('status read down');
    expect(runNowButton()).not.toBeDisabled();
  });

  it.each([
    [
      'discovery is off',
      apiError(409, { code: 'discovery-disabled', message: 'Model discovery is turned off' }),
      'Discovery is off. Turn it on to check providers for new models every 6 hours.',
    ],
    [
      'a listing holds the lease',
      apiError(409, { code: 'listing-in-progress' }),
      'A listing is in progress, try again in a few seconds',
    ],
    [
      'no driver can run it',
      apiError(503, { message: 'Model discovery function is not linked to this deployment.' }),
      'Run now is not available here. Model discovery function is not linked to this deployment.',
    ],
    [
      'a delegate posts anyway',
      apiError(403, { error: 'Only full administrators can change model settings.' }),
      'Only full administrators can change model settings.',
    ],
  ])('shows an inline error when %s', async (_case, error, expected) => {
    m.post.mockRejectedValueOnce(error);
    await mountAndDispatch();

    expect(screen.getByTestId('discovery-run-now-error')).toHaveTextContent(expected);
    expect(runNowButton()).not.toBeDisabled();
  });

  it('leaves no timer behind when the page closes mid-poll', async () => {
    const { unmount } = await mountAndDispatch();
    await tick(POLL_INTERVAL_MS);

    unmount();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    expect(useRunNowStore.getState().phase).toBe('idle');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

import { DiscoveryStatusCard } from './DiscoveryStatusCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const CRON_RUN = {
  startedAt: '2026-07-26T12:00:00.000Z',
  finishedAt: '2026-07-26T12:03:00.000Z',
  trigger: 'cron',
  host: 'hosted',
  status: 'partial',
  sources: [
    { name: 'openai', ok: true, durationMs: 120 },
    { name: 'anthropic', ok: true, durationMs: 140 },
    { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
  ],
  joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
  changes: { added: 2, promoted: 1, deprecated: 0, repriced: 0, flagged: 0 },
};

const STATUS = {
  lastRun: CRON_RUN,
  lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
  enabled: true,
  mode: 'report',
  autoEnable: 'priced',
  selfHost: false,
};

type Run = typeof CRON_RUN;
const runLike = (over: Partial<Run>): Run => ({ ...CRON_RUN, ...over });
const statusWith = (lastRun: Run | null, over: Partial<typeof STATUS> = {}) => ({ ...STATUS, lastRun, ...over });

const renderCard = () =>
  render(
    <TestWrapper>
      <DiscoveryStatusCard />
    </TestWrapper>
  );

describe('DiscoveryStatusCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: STATUS });
    mockPost.mockResolvedValue({ data: { dispatched: 'lambda' } });
  });

  it('renders the last run, the source tally and the settings badges', async () => {
    renderCard();

    expect(await screen.findByTestId('discovery-status-run-chip')).toHaveTextContent('partial');
    expect(screen.getByTestId('discovery-status-mode-chip')).toHaveTextContent('report');
    expect(screen.getByTestId('discovery-status-autoenable-chip')).toHaveTextContent('priced');
    expect(screen.getByTestId('discovery-status-last-run')).toHaveTextContent('cron on hosted');
    expect(screen.getByTestId('discovery-status-sources')).toHaveTextContent('2/3 sources ok');
    expect(screen.getByTestId('discovery-status-coverage-models.dev')).toHaveTextContent('84/113');
    expect(screen.getByTestId('discovery-status-changes')).toHaveTextContent('2 added, 1 promoted');
    expect(screen.queryByTestId('discovery-status-disabled-chip')).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/model-discovery');
  });

  it('names the failed source and its error on demand', async () => {
    renderCard();
    fireEvent.click(await screen.findByTestId('discovery-status-failures-toggle'));

    expect(screen.getByTestId('discovery-status-failure-models.dev')).toHaveTextContent('ETIMEDOUT');
  });

  it('says so when discovery has never run', async () => {
    mockGet.mockResolvedValue({ data: statusWith(null, { lastSuccessfulRunAt: null }) });
    renderCard();

    expect(await screen.findByTestId('discovery-status-never-run')).toBeInTheDocument();
  });

  it('says the master switch is off and refuses to dispatch', async () => {
    mockGet.mockResolvedValue({ data: statusWith(CRON_RUN, { enabled: false }) });
    renderCard();

    expect(await screen.findByTestId('discovery-status-disabled-chip')).toHaveTextContent('disabled');
    expect(screen.getByTestId('discovery-status-disabled-notice')).toHaveTextContent('enableModelDiscovery');
    expect(screen.getByTestId('model-lifecycle-run-now-btn')).toHaveAttribute('disabled');
  });

  it('surfaces the server reason when the dispatch is refused', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 409',
      response: { data: { code: 'discovery-disabled', message: 'Model discovery is turned off' } },
    });
    renderCard();

    fireEvent.click(await screen.findByTestId('model-lifecycle-run-now-btn'));

    expect(await screen.findByTestId('discovery-status-error')).toHaveTextContent('turned off');
    expect(screen.queryByTestId('discovery-status-notice')).not.toBeInTheDocument();
  });
});

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

/** Drive the poll loop: fires the due sleep, then lets its api.get settle. */
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const runNowButton = () => screen.getByTestId('model-lifecycle-run-now-btn');

describe('DiscoveryStatusCard run now', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue({ data: STATUS });
    mockPost.mockResolvedValue({ data: { dispatched: 'lambda' } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mount, settle the initial load, then click Run now and settle the dispatch. */
  const mountAndDispatch = async () => {
    const view = renderCard();
    await tick();
    fireEvent.click(runNowButton());
    await tick();
    return view;
  };

  it('polls until the manual run reports, then says how it went', async () => {
    const manualRunning = runLike({ startedAt: '2026-07-26T12:10:00.000Z', finishedAt: null, trigger: 'manual' });
    mockGet
      .mockResolvedValueOnce({ data: STATUS }) // mount
      .mockResolvedValueOnce({ data: STATUS }) // baseline refresh before the POST
      .mockResolvedValueOnce({ data: STATUS }) // poll 1: nothing yet
      .mockResolvedValueOnce({ data: statusWith(manualRunning) })
      .mockResolvedValue({
        data: statusWith(runLike({ ...manualRunning, finishedAt: '2026-07-26T12:12:00.000Z', status: 'ok' })),
      });

    await mountAndDispatch();
    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('Dispatched (lambda)');

    await tick(POLL_INTERVAL_MS);
    await tick(POLL_INTERVAL_MS);
    expect(screen.getByTestId('discovery-status-waiting')).toBeInTheDocument();

    await tick(POLL_INTERVAL_MS);
    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('Run finished: ok.');
    expect(screen.queryByTestId('discovery-status-waiting')).not.toBeInTheDocument();
    expect(runNowButton()).not.toHaveAttribute('disabled');
  });

  it('stays disabled for the whole dispatch-and-wait window, not just the POST', async () => {
    await mountAndDispatch();

    expect(runNowButton()).toHaveAttribute('disabled');
    await tick(POLL_INTERVAL_MS * 3);
    expect(runNowButton()).toHaveAttribute('disabled');
    expect(screen.getByTestId('discovery-status-waiting')).toBeInTheDocument();

    // Only one loop can exist, so one dispatch is all the endpoint ever sees.
    fireEvent.click(runNowButton());
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('gives up after two minutes and blames the lease when no run ever appeared', async () => {
    await mountAndDispatch();
    await tick(POLL_TIMEOUT_MS);

    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('another run may already hold the lease');
    expect(runNowButton()).not.toHaveAttribute('disabled');
  });

  it('blames the master switch instead of the lease when discovery was turned off mid-wait', async () => {
    mockGet
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValue({ data: statusWith(CRON_RUN, { enabled: false }) });

    await mountAndDispatch();
    await tick(POLL_TIMEOUT_MS);

    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('enableModelDiscovery');
    expect(screen.getByTestId('discovery-status-notice')).not.toHaveTextContent('lease');
  });

  it('re-reads the baseline before dispatching, so a run started before the click is not claimed', async () => {
    // Someone else's manual run landed while this tab sat open: newer than the
    // run on screen at mount, so a stale baseline would report it as finished.
    const otherManual = runLike({
      startedAt: '2026-07-26T12:04:00.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      trigger: 'manual',
      status: 'ok',
    });
    mockGet.mockResolvedValueOnce({ data: STATUS }).mockResolvedValue({ data: statusWith(otherManual) });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS * 3);

    expect(screen.getByTestId('discovery-status-notice')).not.toHaveTextContent('Run finished');
    expect(screen.getByTestId('discovery-status-waiting')).toBeInTheDocument();
  });

  it('ignores a cron run that lands mid-wait and keeps waiting for the manual one', async () => {
    const cronMidWait = runLike({ startedAt: '2026-07-26T12:10:00.000Z', finishedAt: '2026-07-26T12:11:00.000Z' });
    const ourManual = runLike({
      startedAt: '2026-07-26T12:12:00.000Z',
      finishedAt: '2026-07-26T12:13:00.000Z',
      trigger: 'manual',
      status: 'ok',
    });
    mockGet
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: statusWith(cronMidWait) })
      .mockResolvedValue({ data: statusWith(ourManual) });

    await mountAndDispatch();

    await tick(POLL_INTERVAL_MS);
    expect(screen.getByTestId('discovery-status-notice')).not.toHaveTextContent('Run finished');

    await tick(POLL_INTERVAL_MS);
    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('Run finished: ok.');
  });

  it('rides out two failed polls and reports the run that arrives on the third', async () => {
    const done = runLike({
      startedAt: '2026-07-26T12:10:00.000Z',
      finishedAt: '2026-07-26T12:11:00.000Z',
      trigger: 'manual',
      status: 'ok',
    });
    mockGet
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockRejectedValueOnce(new Error('network blip'))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue({ data: statusWith(done) });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS * 3);

    expect(screen.queryByTestId('discovery-status-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('Run finished: ok.');
  });

  it('stops waiting once three polls fail in a row', async () => {
    mockGet
      .mockResolvedValueOnce({ data: STATUS })
      .mockResolvedValueOnce({ data: STATUS })
      .mockRejectedValue({ message: 'Network Error' });

    await mountAndDispatch();
    await tick(POLL_INTERVAL_MS * 3);

    expect(screen.getByTestId('discovery-status-error')).toHaveTextContent('Network Error');
    expect(runNowButton()).not.toHaveAttribute('disabled');
  });

  it('leaves no timer behind when the tab closes mid-poll', async () => {
    const { unmount } = await mountAndDispatch();
    await tick(POLL_INTERVAL_MS);

    const callsAtUnmount = mockGet.mock.calls.length;
    unmount();

    await tick(POLL_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(mockGet.mock.calls.length).toBe(callsAtUnmount);
  });
});

describe('DiscoveryStatusCard load failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ data: { dispatched: 'lambda' } });
  });

  it('reports a failed initial status read', async () => {
    mockGet.mockRejectedValue({ message: 'Request failed with status code 500' });
    renderCard();

    await waitFor(() => expect(screen.getByTestId('discovery-status-error')).toBeInTheDocument());
    expect(screen.getByTestId('discovery-status-error')).toHaveTextContent('500');
  });
});

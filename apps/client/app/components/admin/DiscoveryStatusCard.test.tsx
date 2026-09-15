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
  id: 'run-1',
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

type Run = typeof CRON_RUN;

/** The run as the polled list carries it: counts, no per-model detail. */
const listOf = (run: Run) => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  host: run.host,
  status: run.status,
  changes: run.changes,
});

const STATUS = {
  lastRun: CRON_RUN,
  runs: [listOf(CRON_RUN)],
  lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
  enabled: true,
  mode: 'report',
  autoEnable: 'priced',
  selfHost: false,
};

const runLike = (over: Partial<Run>): Run => ({ ...CRON_RUN, ...over });
const statusWith = (lastRun: Run | null, over: Partial<typeof STATUS> = {}) => ({
  ...STATUS,
  lastRun,
  // runs[0] is lastRun by construction server-side; keep the fixture honest.
  runs: lastRun ? [listOf(lastRun)] : [],
  ...over,
});

/** One run in full, as GET ?runId= answers it. */
const RUN_DETAIL = {
  id: 'run-1',
  startedAt: CRON_RUN.startedAt,
  finishedAt: CRON_RUN.finishedAt,
  trigger: 'cron',
  host: 'hosted',
  status: 'partial',
  passes: 1,
  sources: [],
  joinCoverage: [],
  changes: {
    added: [],
    promoted: [],
    deprecated: [],
    repriced: [],
    flagged: ['gpt-5.6-luna'],
    operatorConflicts: [],
    plannedRows: 0,
    appendedRows: 0,
    plannedPriceRows: 0,
    appendedPriceRows: 0,
  },
  priceFlags: [
    {
      modelId: 'gpt-5.6-luna',
      kind: 'source-disagreement',
      proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
      current: { inputPerMTok: 1, outputPerMTok: 6 },
      sources: ['models.dev', 'litellm'],
      detail: 'sources disagree beyond 10%; applied neither',
    },
  ],
  priceRows: [],
  priceSkips: [],
  lifecycleTransitions: [],
  catalogDiff: [],
  unmatchedIds: [],
  droppedRecords: [],
};

/**
 * Route the two GETs this card can trigger: its own status, and the detail modal's
 * run report (echoing back whichever run id was asked for).
 */
const routeGets = (status: unknown = STATUS) =>
  mockGet.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('runId=')
        ? { data: { run: { ...RUN_DETAIL, id: decodeURIComponent(url.split('runId=')[1]) } } }
        : { data: status }
    )
  );

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

  it('states the retention window, so an operator knows how far back runs go', async () => {
    renderCard();

    expect(await screen.findByTestId('discovery-status-retention')).toHaveTextContent('90 days');
  });
});

const OLDER_RUNS = [
  listOf(CRON_RUN),
  listOf(
    runLike({
      id: 'run-0',
      startedAt: '2026-07-26T06:00:00.000Z',
      finishedAt: '2026-07-26T06:02:00.000Z',
      trigger: 'manual',
      status: 'ok',
      changes: { added: 0, promoted: 0, deprecated: 0, repriced: 3, flagged: 34 },
    })
  ),
];

describe('DiscoveryStatusCard run history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeGets();
    mockPost.mockResolvedValue({ data: { dispatched: 'lambda' } });
  });

  it('opens the last run report from the change-count sentence', async () => {
    renderCard();

    fireEvent.click(await screen.findByTestId('discovery-status-changes'));

    expect(await screen.findByTestId('discovery-run-modal')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/model-discovery?runId=run-1');
    // The counts sentence led straight to the model and the reason behind it.
    expect(screen.getByTestId('discovery-run-flag-detail-gpt-5.6-luna')).toHaveTextContent('applied neither');
  });

  it('lists the recent runs with their trigger, status and counts, and opens a prior one', async () => {
    routeGets({ ...STATUS, runs: OLDER_RUNS });
    renderCard();

    fireEvent.click(await screen.findByTestId('discovery-status-history-toggle'));

    const list = screen.getByTestId('discovery-status-history-list');
    expect(list).toHaveTextContent('cron');
    const prior = screen.getByTestId('discovery-status-history-run-run-0');
    expect(prior).toHaveTextContent('manual');
    expect(prior).toHaveTextContent('ok');
    expect(prior).toHaveTextContent('3 repriced, 34 flagged');

    fireEvent.click(prior);

    expect(await screen.findByTestId('discovery-run-modal')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/model-discovery?runId=run-0');
  });

  it('offers no history toggle when the only run is the one already on the card', async () => {
    renderCard();

    await screen.findByTestId('discovery-status-changes');
    expect(screen.queryByTestId('discovery-status-history-toggle')).not.toBeInTheDocument();
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

  it('keeps an open run report on the run the operator chose while the card polls underneath it', async () => {
    const newerManual = runLike({
      id: 'run-2',
      startedAt: '2026-07-26T12:10:00.000Z',
      finishedAt: '2026-07-26T12:11:00.000Z',
      trigger: 'manual',
      status: 'ok',
    });
    let latest: unknown = STATUS;
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('runId=')
          ? { data: { run: { ...RUN_DETAIL, id: decodeURIComponent(url.split('runId=')[1]) } } }
          : { data: latest }
      )
    );

    renderCard();
    await tick();
    fireEvent.click(screen.getByTestId('discovery-status-changes'));
    await tick();
    expect(screen.getByTestId('discovery-run-modal')).toHaveTextContent('run-1');

    fireEvent.click(runNowButton());
    await tick();
    latest = statusWith(newerManual);
    await tick(POLL_INTERVAL_MS);
    await tick(POLL_INTERVAL_MS);

    // The card moved on to the newer run; the report being read did not, and the
    // poll never re-fetched it.
    expect(screen.getByTestId('discovery-status-notice')).toHaveTextContent('Run finished: ok.');
    expect(screen.getByTestId('discovery-run-modal')).toHaveTextContent('run-1');
    expect(mockGet.mock.calls.filter(([url]) => String(url).includes('runId=')).length).toBe(1);
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

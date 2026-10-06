import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import RunList from './RunList';
import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';

// Tue Oct 6 2026, local. Run times below are built from local parts so the day boundaries hold in any TZ.
const NOW = new Date(2026, 9, 6, 12, 0);
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const PASSED = { passed: 83, failed: 0, skipped: 0, notStarted: 0, ran: 83, total: 83 };

const run = (o: Partial<QaRunSummary> = {}): QaRunSummary => ({
  id: 'r1',
  product: 'product-a',
  suite: 'Core',
  env: 'staging',
  branch: 'main',
  trigger: 'Run via Deployer',
  source: 'ci',
  status: 'failed',
  startedAt: new Date().toISOString(),
  durationMs: 252_000,
  counts: { passed: 81, failed: 2, skipped: 0, notStarted: 0, ran: 83, total: 83 },
  ciRunUrl: 'https://github.com/example/repo/actions/runs/1',
  sha: 'abc123',
  ...o,
});

const renderList = (runs: QaRunSummary[], extra: Partial<Parameters<typeof RunList>[0]> = {}) =>
  render(
    <RunList
      runs={runs}
      onOpenRun={vi.fn()}
      renderExpanded={r => <div>expanded {r.id}</div>}
      hasMore={false}
      onLoadMore={vi.fn()}
      {...extra}
    />,
    { wrapper: QaTestWrapper }
  );

describe('RunList', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the spec row: suite, env, passed/ran, failed, duration', () => {
    renderList([run()]);
    const row = screen.getByTestId('qa-run-row');
    for (const text of ['Core', 'staging', '81/83', '2 failed', '4m12s']) expect(row).toHaveTextContent(text);
  });

  it('expands inline and opens the full run', () => {
    const onOpenRun = vi.fn();
    renderList([run()], { onOpenRun });
    expect(screen.queryByTestId('qa-run-expanded')).toBeNull();
    fireEvent.click(screen.getByTestId('qa-run-expand-btn'));
    expect(screen.getByTestId('qa-run-expanded')).toHaveTextContent('expanded r1');
    fireEvent.click(screen.getByTestId('qa-run-open-btn'));
    expect(onOpenRun).toHaveBeenCalledWith('r1');
  });

  it('marks backfilled and env-down runs', () => {
    renderList([
      run({ id: 'a', source: 'slack-backfill' }),
      run({
        id: 'b',
        status: 'infra-error',
        counts: { passed: 0, failed: 0, skipped: 0, notStarted: 90, ran: 0, total: 0 },
      }),
    ]);
    expect(screen.getByTestId('qa-run-slack-chip')).toHaveTextContent('from Slack');
    expect(screen.getByTestId('qa-run-env-down-chip')).toHaveTextContent('env down: 0 of 90 ran');
  });

  it('loads more when there is a next page', () => {
    const onLoadMore = vi.fn();
    renderList([run()], { hasMore: true, onLoadMore });
    fireEvent.click(screen.getByTestId('qa-runs-more-btn'));
    expect(onLoadMore).toHaveBeenCalled();
  });

  describe('grouping', () => {
    const dayHeaders = () => screen.getAllByTestId('qa-day-toggle-btn');

    it('groups by day newest first, then by suite with the most recent run first', () => {
      renderList([
        run({ id: 'e', suite: 'Full', startedAt: at(3) }),
        run({ id: 'a', suite: 'Core', startedAt: at(6, 9) }),
        run({ id: 'd', suite: 'Core', startedAt: at(5, 23, 50) }),
        run({ id: 'b', suite: 'Auth', startedAt: at(6, 11) }),
        run({ id: 'c', suite: 'Core', startedAt: at(6, 10) }),
      ]);
      const days = screen.getAllByTestId('qa-day-group');
      expect(days).toHaveLength(3);
      expect(dayHeaders()[0]).toHaveTextContent('Today');
      expect(dayHeaders()[0]).toHaveTextContent('3 runs');
      expect(dayHeaders()[1]).toHaveTextContent('Yesterday');
      expect(dayHeaders()[2]).toHaveTextContent(/Oct.*3|3.*Oct/);

      const suites = within(days[0]).getAllByTestId('qa-suite-group');
      expect(suites.map(g => within(g).getByTestId('qa-suite-toggle-btn').textContent)).toEqual([
        expect.stringContaining('Auth'),
        expect.stringContaining('Core'),
      ]);
      const coreRows = within(suites[1]).getAllByTestId('qa-run-row');
      expect(coreRows[0]).toHaveTextContent('10:00');
      expect(coreRows[1]).toHaveTextContent('09:00');
    });

    it('splits days on the local midnight boundary', () => {
      renderList([run({ id: 'late', startedAt: at(5, 23, 59) }), run({ id: 'early', startedAt: at(6, 0, 1) })]);
      expect(dayHeaders()).toHaveLength(2);
      expect(dayHeaders()[0]).toHaveTextContent('Today');
      expect(dayHeaders()[0]).toHaveTextContent('1 run');
      expect(dayHeaders()[1]).toHaveTextContent('Yesterday');
      expect(dayHeaders()[1]).toHaveTextContent('1 run');
    });

    it('expands today (day and suites) and collapses other days by default', () => {
      renderList([
        run({ id: 'a', suite: 'Core', startedAt: at(6, 9) }),
        run({ id: 'b', suite: 'Auth', startedAt: at(6, 10) }),
        run({ id: 'c', suite: 'Core', startedAt: at(5) }),
      ]);
      expect(dayHeaders().map(h => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
      const [today, yesterday] = screen.getAllByTestId('qa-day-group');
      expect(within(today).getAllByTestId('qa-suite-group')).toHaveLength(2);
      expect(within(today).getAllByTestId('qa-run-row')).toHaveLength(2);
      expect(within(yesterday).queryByTestId('qa-suite-group')).toBeNull();
      expect(within(yesterday).queryByTestId('qa-run-row')).toBeNull();
    });

    it('expands the newest day when nothing ran today', () => {
      renderList([run({ id: 'a', startedAt: at(4) }), run({ id: 'b', startedAt: at(2) })]);
      expect(dayHeaders().map(h => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
      expect(screen.getAllByTestId('qa-run-row')).toHaveLength(1);
    });

    it('toggles days and suites, and keeps the choice when the runs change', () => {
      const runs = [
        run({ id: 'a', suite: 'Core', startedAt: at(6, 9) }),
        run({ id: 'c', suite: 'Core', startedAt: at(5) }),
      ];
      const { rerender } = renderList(runs);
      expect(screen.getAllByTestId('qa-run-row')).toHaveLength(1);

      fireEvent.click(dayHeaders()[1]);
      expect(dayHeaders()[1]).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getAllByTestId('qa-run-row')).toHaveLength(2);

      fireEvent.click(screen.getAllByTestId('qa-suite-toggle-btn')[0]);
      expect(screen.getAllByTestId('qa-run-row')).toHaveLength(1);

      fireEvent.click(dayHeaders()[0]);
      expect(dayHeaders()[0]).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getAllByTestId('qa-run-row')).toHaveLength(1);

      rerender(
        <RunList
          runs={[...runs, run({ id: 'z', startedAt: at(1) })]}
          onOpenRun={vi.fn()}
          renderExpanded={() => null}
          hasMore={false}
          onLoadMore={vi.fn()}
        />
      );
      expect(dayHeaders().map(h => h.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
    });
  });

  describe('failure visibility', () => {
    it('flags failing rows with the danger icon and leaves passing and env-down rows plain', () => {
      renderList([
        run({ id: 'failed-tests', startedAt: at(6, 12) }),
        run({ id: 'failed-run', status: 'failed', counts: { ...PASSED, passed: 0, ran: 0 }, startedAt: at(6, 11) }),
        run({ id: 'passed', status: 'passed', counts: PASSED, startedAt: at(6, 10) }),
        run({
          id: 'env-down',
          status: 'infra-error',
          counts: { passed: 0, failed: 0, skipped: 0, notStarted: 90, ran: 0, total: 0 },
          startedAt: at(6, 9),
        }),
      ]);
      const rows = screen.getAllByTestId('qa-run-row');
      expect(rows).toHaveLength(4);
      expect(within(rows[0]).getByTestId('qa-run-failed-icon')).toBeInTheDocument();
      expect(within(rows[0]).getByText('2 failed')).toBeInTheDocument();
      expect(within(rows[1]).getByTestId('qa-run-failed-icon')).toBeInTheDocument();
      expect(within(rows[2]).queryByTestId('qa-run-failed-icon')).toBeNull();
      expect(within(rows[3]).queryByTestId('qa-run-failed-icon')).toBeNull();
      expect(within(rows[3]).getByTestId('qa-run-env-down-chip')).toBeInTheDocument();
    });

    it('keeps failing rows expandable and openable', () => {
      const onOpenRun = vi.fn();
      renderList([run({ id: 'bad' })], { onOpenRun });
      fireEvent.click(screen.getByTestId('qa-run-expand-btn'));
      expect(screen.getByTestId('qa-run-expanded')).toHaveTextContent('expanded bad');
      fireEvent.click(screen.getByTestId('qa-run-open-btn'));
      expect(onOpenRun).toHaveBeenCalledWith('bad');
    });

    it('shows failed-run chips on day and suite headers, also while collapsed', () => {
      renderList([
        run({ id: 'a', suite: 'Core', startedAt: at(6, 10) }),
        run({ id: 'b', suite: 'Core', status: 'passed', counts: PASSED, startedAt: at(6, 9) }),
        run({ id: 'c', suite: 'Auth', status: 'passed', counts: PASSED, startedAt: at(6, 8) }),
        run({ id: 'd', suite: 'Full', startedAt: at(5, 10) }),
        run({ id: 'e', suite: 'Full', startedAt: at(5, 9) }),
        run({ id: 'f', suite: 'Full', status: 'passed', counts: PASSED, startedAt: at(5, 8) }),
      ]);
      const [today, yesterday] = screen.getAllByTestId('qa-day-group');
      expect(within(today).getByTestId('qa-day-failed-chip')).toHaveTextContent('1 failed');
      const [core, auth] = within(today).getAllByTestId('qa-suite-group');
      expect(within(core).getByTestId('qa-suite-failed-chip')).toHaveTextContent('1 failed');
      expect(within(auth).queryByTestId('qa-suite-failed-chip')).toBeNull();

      // Yesterday is collapsed: the chip counts failing runs, not failed tests.
      expect(within(yesterday).queryByTestId('qa-suite-group')).toBeNull();
      expect(within(yesterday).getByTestId('qa-day-failed-chip')).toHaveTextContent('2 failed');
      expect(within(yesterday).getByTestId('qa-day-toggle-btn')).toHaveTextContent('3 runs');
    });

    it('omits header chips when nothing failed', () => {
      renderList([run({ status: 'passed', counts: PASSED })]);
      expect(screen.queryByTestId('qa-day-failed-chip')).toBeNull();
      expect(screen.queryByTestId('qa-suite-failed-chip')).toBeNull();
    });
  });
});

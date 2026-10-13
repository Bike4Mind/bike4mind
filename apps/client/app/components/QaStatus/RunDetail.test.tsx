import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import RunDetail from './RunDetail';
import type { QaRunDetail, QaTestView } from '@client/app/hooks/data/qaStatus';

const detail = (o: Partial<QaRunDetail> = {}): QaRunDetail => ({
  run: {
    id: 'r1',
    product: 'product-a',
    suite: 'Core',
    env: 'staging',
    branch: 'main',
    trigger: 'Run via Deployer',
    source: 'ci',
    status: 'failed',
    startedAt: '2026-09-28T09:00:00.000Z',
    durationMs: 252_000,
    counts: { passed: 81, failed: 1, skipped: 0, notStarted: 0, ran: 82, total: 82 },
    ciRunUrl: 'https://github.com/example/repo/actions/runs/1',
    sha: 'abc1234def',
    suiteSummary: [{ name: 'Notebook', passed: 3, ran: 4, notRun: 0 }],
    metrics: [{ kind: 'credits', model: 'model-x', value: 12, unit: 'credits', threshold: 30 }],
  },
  failedTests: [
    {
      testKey: 'notebook.spec.ts > Notebook > saves',
      title: 'Notebook > saves',
      status: 'failed',
      durationMs: 9000,
      retries: 2,
      error: 'expect(locator).toBeVisible() failed',
      media: [
        { kind: 'screenshot', state: 'ok', url: 'https://s3.example/shot.png' },
        { kind: 'video', state: 'expired' },
        { kind: 'trace', state: 'ok', url: 'https://s3.example/trace.zip' },
      ],
    },
  ],
  flakyTests: [],
  medianDurationMs: null,
  tests: [],
  diff: null,
  report: { state: 'ok', url: '/api/admin/qa/report/r1/t/index.html' },
  ...o,
});

const testView = (o: Partial<QaTestView> & Pick<QaTestView, 'testKey'>): QaTestView => ({
  title: o.testKey.split(' > ').slice(1).join(' > '),
  status: 'passed',
  durationMs: 1000,
  retries: 0,
  media: [],
  ...o,
});

const diff = (o: Partial<NonNullable<QaRunDetail['diff']>> = {}): NonNullable<QaRunDetail['diff']> => ({
  previousRunId: 'r0',
  previousStartedAt: '2026-09-27T09:00:00.000Z',
  newlyFailing: [],
  recovered: [],
  added: [],
  removed: [],
  ...o,
});

describe('RunDetail', () => {
  it('shows suites, metrics, the error and each media item', () => {
    render(<RunDetail detail={detail()} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-run-suites')).toHaveTextContent('Notebook 3/4');
    expect(screen.getByTestId('qa-run-metrics')).toHaveTextContent('model-x');
    const card = screen.getByTestId('qa-failed-test');
    expect(card).toHaveTextContent('expect(locator).toBeVisible() failed');
    expect(screen.getByTestId('qa-media-screenshot').querySelector('img')?.getAttribute('src')).toBe(
      'https://s3.example/shot.png'
    );
    expect(screen.getByTestId('qa-media-video')).toHaveTextContent('video expired');
    expect(screen.getByTestId('qa-media-trace').getAttribute('href')).toBe('https://s3.example/trace.zip');
    expect(card).toHaveTextContent('npx playwright show-trace');
    expect(screen.getByTestId('qa-run-report-link').getAttribute('href')).toBe('/api/admin/qa/report/r1/t/index.html');
  });

  it('shows "screenshot expired" and no report link for an old run', () => {
    const d = detail({ report: { state: 'expired' } });
    d.failedTests[0].media = [{ kind: 'screenshot', state: 'expired' }];
    render(<RunDetail detail={d} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-media-screenshot')).toHaveTextContent('screenshot expired');
    expect(screen.queryByTestId('qa-run-report-link')).toBeNull();
    expect(screen.getByTestId('qa-run-report-state')).toHaveTextContent('report expired');
  });

  it('shows the from Slack chip on backfilled runs', () => {
    const d = detail();
    d.run.source = 'slack-backfill';
    render(<RunDetail detail={d} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-run-slack-chip')).toHaveTextContent('from Slack');
  });

  it('opens a failed test history', () => {
    const onOpenTest = vi.fn();
    render(<RunDetail detail={detail()} onOpenTest={onOpenTest} />, { wrapper: QaTestWrapper });
    fireEvent.click(screen.getByTestId('qa-failed-test-history-btn'));
    expect(onOpenTest).toHaveBeenCalledWith('notebook.spec.ts > Notebook > saves');
  });

  describe('header facts', () => {
    it('links the short SHA to the commit and shows the trigger', () => {
      render(<RunDetail detail={detail()} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      const sha = screen.getByTestId('qa-run-sha');
      expect(sha).toHaveTextContent('abc1234');
      expect(sha).not.toHaveTextContent('abc1234d');
      expect(sha.getAttribute('href')).toBe('https://github.com/example/repo/commit/abc1234def');
      expect(screen.getByTestId('qa-run-trigger')).toHaveTextContent('Run via Deployer');
    });

    it('shows the SHA as plain text when the CI url is not a GitHub run', () => {
      const d = detail();
      d.run.ciRunUrl = 'https://slack.example/archives/C1/p1';
      render(<RunDetail detail={d} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      expect(screen.getByTestId('qa-run-sha')).toHaveTextContent('abc1234');
      expect(screen.getByTestId('qa-run-sha').getAttribute('href')).toBeNull();
    });

    it('omits the SHA when the run has none', () => {
      const d = detail();
      d.run.sha = '';
      render(<RunDetail detail={d} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      expect(screen.queryByTestId('qa-run-sha')).toBeNull();
    });

    it('shows the duration against the 7d median', () => {
      render(<RunDetail detail={detail({ medianDurationMs: 212_000 })} onOpenTest={vi.fn()} />, {
        wrapper: QaTestWrapper,
      });
      expect(screen.getByTestId('qa-run-duration')).toHaveTextContent('4m12s (+40s vs 7d median)');
    });

    it('shows a faster run with a minus sign and no delta without a baseline', () => {
      const { rerender } = render(<RunDetail detail={detail({ medianDurationMs: 300_000 })} onOpenTest={vi.fn()} />, {
        wrapper: QaTestWrapper,
      });
      expect(screen.getByTestId('qa-run-duration')).toHaveTextContent('4m12s (-48s vs 7d median)');
      rerender(<RunDetail detail={detail({ medianDurationMs: null })} onOpenTest={vi.fn()} />);
      expect(screen.getByTestId('qa-run-duration').textContent).toBe('4m12s');
    });
  });

  describe('tests list', () => {
    const tests = [
      testView({ testKey: 'auth.spec.ts > Auth > logs in', durationMs: 2000, medianMs: 1000 }),
      testView({ testKey: 'auth.spec.ts > Auth > logs out', durationMs: 5000, medianMs: 4500 }),
      testView({ testKey: 'notebook.spec.ts > Notebook > saves', status: 'failed', durationMs: 800, retries: 2 }),
      testView({ testKey: 'e2e/mfa-setup.spec.ts > Mfa > enrolls', status: 'flaky', durationMs: 300 }),
      testView({ testKey: 'e2e/mfa-setup.spec.ts > Mfa > skipped', status: 'skipped', durationMs: 0 }),
    ];

    it('groups tests by suite name with failing groups first and slowest first inside', () => {
      render(<RunDetail detail={detail({ tests })} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      const groups = screen.getAllByTestId('qa-test-group');
      expect(groups).toHaveLength(3);
      expect(groups[0]).toHaveTextContent('Notebook');
      expect(groups[0]).toHaveTextContent('1 test, 1 failed');
      expect(groups[1]).toHaveTextContent('Auth');
      expect(groups[2]).toHaveTextContent('Mfa Setup');
      const authRows = groups[1].querySelectorAll('[data-testid="qa-test-row"]');
      expect(authRows[0]).toHaveTextContent('Auth > logs out');
      expect(authRows[1]).toHaveTextContent('Auth > logs in');
    });

    it('shows status, retries and duration per row', () => {
      render(<RunDetail detail={detail({ tests })} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      const rows = screen.getAllByTestId('qa-test-row');
      expect(rows.map(r => r.getAttribute('data-status')).sort()).toEqual([
        'failed',
        'flaky',
        'passed',
        'passed',
        'skipped',
      ]);
      const failed = rows.find(r => r.getAttribute('data-status') === 'failed');
      expect(failed).toHaveTextContent('2 retries');
      expect(failed).toHaveTextContent('800ms');
      expect(rows.find(r => r.textContent?.includes('logs out'))).toHaveTextContent('5.0s');
    });

    it('flags a test at least 50% slower than its median and not a smaller increase', () => {
      render(<RunDetail detail={detail({ tests })} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      const deltas = screen.getAllByTestId('qa-test-delta');
      expect(deltas).toHaveLength(2);
      const byRow = (title: string) =>
        screen
          .getAllByTestId('qa-test-row')
          .find(r => r.textContent?.includes(title))
          ?.querySelector('[data-testid="qa-test-delta"]');
      expect(byRow('logs in')).toHaveTextContent('+1.0s vs 7d median');
      expect(byRow('logs in')?.getAttribute('data-slow')).toBe('true');
      expect(byRow('logs out')).toHaveTextContent('+500ms vs 7d median');
      expect(byRow('logs out')?.getAttribute('data-slow')).toBe('false');
    });

    it('opens a test history from its row', () => {
      const onOpenTest = vi.fn();
      render(<RunDetail detail={detail({ tests })} onOpenTest={onOpenTest} />, { wrapper: QaTestWrapper });
      fireEvent.click(screen.getAllByTestId('qa-test-history-btn')[0]);
      expect(onOpenTest).toHaveBeenCalledWith('notebook.spec.ts > Notebook > saves');
    });

    it('is not rendered inline in the run list, nor when there are no tests', () => {
      const { rerender } = render(<RunDetail detail={detail({ tests })} onOpenTest={vi.fn()} compact />, {
        wrapper: QaTestWrapper,
      });
      expect(screen.queryByTestId('qa-run-tests')).toBeNull();
      rerender(<RunDetail detail={detail({ tests: [] })} onOpenTest={vi.fn()} />);
      expect(screen.queryByTestId('qa-run-tests')).toBeNull();
    });
  });

  describe('since previous run', () => {
    it('lists each non-empty bucket and opens the previous run', () => {
      const onOpenRun = vi.fn();
      const d = detail({
        diff: diff({
          newlyFailing: [{ testKey: 'k1', title: 'Notebook > saves' }],
          recovered: [{ testKey: 'k2', title: 'Auth > logs in' }],
          removed: [{ testKey: 'k3', title: 'Old > gone' }],
        }),
      });
      render(<RunDetail detail={d} onOpenTest={vi.fn()} onOpenRun={onOpenRun} />, { wrapper: QaTestWrapper });
      expect(screen.getByTestId('qa-run-diff-newly-failing')).toHaveTextContent('Newly failing1Notebook > saves');
      expect(screen.getByTestId('qa-run-diff-recovered')).toHaveTextContent('Auth > logs in');
      expect(screen.getByTestId('qa-run-diff-removed')).toHaveTextContent('Old > gone');
      expect(screen.queryByTestId('qa-run-diff-added')).toBeNull();
      expect(screen.queryByTestId('qa-run-diff-empty')).toBeNull();
      fireEvent.click(screen.getByTestId('qa-run-diff-prev-link'));
      expect(onOpenRun).toHaveBeenCalledWith('r0');
    });

    it('opens a changed test history', () => {
      const onOpenTest = vi.fn();
      const d = detail({ diff: diff({ added: [{ testKey: 'k9', title: 'New > thing' }] }) });
      render(<RunDetail detail={d} onOpenTest={onOpenTest} />, { wrapper: QaTestWrapper });
      fireEvent.click(screen.getByTestId('qa-run-diff-test'));
      expect(onOpenTest).toHaveBeenCalledWith('k9');
    });

    it('says so when nothing changed', () => {
      render(<RunDetail detail={detail({ diff: diff() })} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
      expect(screen.getByTestId('qa-run-diff-empty')).toHaveTextContent('No changes since previous run');
    });

    it('caps a long list', () => {
      const added = Array.from({ length: 13 }, (_, i) => ({ testKey: `k${i}`, title: `New > t${i}` }));
      render(<RunDetail detail={detail({ diff: diff({ added }) })} onOpenTest={vi.fn()} />, {
        wrapper: QaTestWrapper,
      });
      expect(screen.getAllByTestId('qa-run-diff-test')).toHaveLength(10);
      expect(screen.getByTestId('qa-run-diff-added')).toHaveTextContent('and 3 more');
    });

    it('is absent without a diff and inline in the run list', () => {
      const d = detail({ diff: diff() });
      const { rerender } = render(<RunDetail detail={d} onOpenTest={vi.fn()} compact />, { wrapper: QaTestWrapper });
      expect(screen.queryByTestId('qa-run-diff')).toBeNull();
      rerender(<RunDetail detail={detail({ diff: null })} onOpenTest={vi.fn()} />);
      expect(screen.queryByTestId('qa-run-diff')).toBeNull();
    });
  });

  it('shows one muted note for an imported run instead of the empty sections', () => {
    const d = detail({ failedTests: [] });
    d.run.source = 'slack-backfill';
    d.run.suiteSummary = [];
    render(<RunDetail detail={d} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-run-backfill-note')).toHaveTextContent(
      'Imported from Slack: counts only, no per-test data'
    );
    for (const id of ['qa-run-suites', 'qa-run-tests', 'qa-run-diff']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('does not show the imported note for a CI run', () => {
    render(<RunDetail detail={detail()} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.queryByTestId('qa-run-backfill-note')).toBeNull();
  });
});

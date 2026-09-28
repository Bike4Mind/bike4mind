import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import RunDetail from './RunDetail';
import type { QaRunDetail } from '@client/app/hooks/data/qaStatus';

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
    sha: 'abc123',
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
  report: { state: 'ok', url: '/api/admin/qa/report/r1/t/index.html' },
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
});

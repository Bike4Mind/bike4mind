import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import RunList from './RunList';
import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';

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
});

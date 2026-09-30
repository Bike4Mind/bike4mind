import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import TestHistory from './TestHistory';

const base = { product: 'product-a', suite: 'Core', env: 'staging', branch: 'main' };
const history = {
  testKey: 'notebook.spec.ts > Notebook > saves',
  title: 'Notebook > saves',
  flake: { failures: 1, total: 4, rate: 0.25 },
  rows: [
    { ...base, runId: 'r2', status: 'passed' as const, startedAt: '2026-09-28T10:00:00.000Z', durationMs: 1000 },
    {
      ...base,
      runId: 'r1',
      status: 'failed' as const,
      startedAt: '2026-09-28T09:00:00.000Z',
      durationMs: 3000,
      error: 'boom',
    },
  ],
};

describe('TestHistory', () => {
  it('shows the flake rate and one row per result', () => {
    render(<TestHistory history={history} onOpenRun={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-test-flake')).toHaveTextContent('failed 1/4 (25%)');
    expect(screen.getAllByTestId('qa-test-history-row')).toHaveLength(2);
  });
  it('opens the run for a row', () => {
    const onOpenRun = vi.fn();
    render(<TestHistory history={history} onOpenRun={onOpenRun} />, { wrapper: QaTestWrapper });
    fireEvent.click(screen.getAllByTestId('qa-test-history-row')[1]);
    expect(onOpenRun).toHaveBeenCalledWith('r1');
  });
});

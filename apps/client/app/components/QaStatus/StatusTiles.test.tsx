import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusTiles from './StatusTiles';
import type { QaTile } from '@client/app/hooks/data/qaStatus';

const tile = (o: Partial<QaTile>): QaTile => ({
  suite: 'Core',
  env: 'staging',
  status: 'passed',
  latestRunId: 'r1',
  startedAt: new Date().toISOString(),
  nonPassingRuns: 0,
  failedCount: 0,
  ...o,
});

describe('StatusTiles', () => {
  it('shows failing since and the failed count', () => {
    const since = new Date();
    since.setHours(9, 14, 0, 0);
    render(
      <StatusTiles
        tiles={[tile({ status: 'failed', failingSince: since.toISOString(), failedCount: 2, nonPassingRuns: 3 })]}
        onOpenRun={vi.fn()}
      />,
      { wrapper: QaTestWrapper }
    );
    expect(screen.getByTestId('qa-tile')).toHaveTextContent('Core . staging');
    expect(screen.getByTestId('qa-tile')).toHaveTextContent('failing since 09:14, 2 tests');
  });

  it('shows env down for infra errors and passing otherwise', () => {
    render(
      <StatusTiles
        tiles={[tile({ status: 'infra-error', env: 'dev', nonPassingRuns: 1 }), tile({})]}
        onOpenRun={vi.fn()}
      />,
      { wrapper: QaTestWrapper }
    );
    const [down, ok] = screen.getAllByTestId('qa-tile');
    expect(down).toHaveTextContent('env down');
    expect(ok).toHaveTextContent('passing');
  });

  it('opens the latest run', () => {
    const onOpenRun = vi.fn();
    render(<StatusTiles tiles={[tile({ latestRunId: 'r9' })]} onOpenRun={onOpenRun} />, { wrapper: QaTestWrapper });
    fireEvent.click(screen.getByTestId('qa-tile'));
    expect(onOpenRun).toHaveBeenCalledWith('r9');
  });
});

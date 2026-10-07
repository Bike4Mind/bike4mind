import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import FlakyTable from './FlakyTable';

const row = {
  testKey: 'notebook.spec.ts > Notebook > saves',
  title: 'Notebook > saves',
  failures: 4,
  total: 20,
  rate: 0.2,
  lastStatus: 'passed' as const,
};

describe('FlakyTable', () => {
  it('shows "failed N/M" and opens the test', () => {
    const onOpenTest = vi.fn();
    render(<FlakyTable rows={[row]} onOpenTest={onOpenTest} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-flaky-row')).toHaveTextContent('failed 4/20');
    fireEvent.click(screen.getByTestId('qa-flaky-row'));
    expect(onOpenTest).toHaveBeenCalledWith(row.testKey);
  });
  it('says so when nothing is flaky', () => {
    render(<FlakyTable rows={[]} onOpenTest={vi.fn()} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-flaky-empty')).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ILoopEventRow } from '@client/app/hooks/data/loops';
import LoopEventLog from './LoopEventLog';

const appTheme = extendTheme({ ...getThemeConfig() });

const event = (overrides: Partial<ILoopEventRow> = {}): ILoopEventRow => ({
  id: 'e1',
  kind: 'unsure',
  executionId: 'exec-1',
  workItemId: 't1',
  ticketTitle: 'Research X',
  iteration: 2,
  confidence: 0.314,
  reason: 'Search results were thin',
  createdAt: '2026-10-29T10:00:00.000Z',
  ...overrides,
});

const renderLog = (data?: ILoopEventRow[], onViewRun = vi.fn()) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopEventLog data={data} onViewRun={onViewRun} />
    </CssVarsProvider>
  );

describe('LoopEventLog', () => {
  it('shows an empty state', () => {
    renderLog([]);
    expect(screen.getByTestId('loop-log-empty')).toBeTruthy();
  });

  it('shows an unanswered unsure run as needing you, with its confidence and reason', () => {
    renderLog([event()]);
    const row = screen.getByTestId('loop-log-row');
    expect(row.textContent).toContain('Research X');
    expect(row.textContent).toContain('31% confidence');
    expect(row.textContent).toContain('Search results were thin');
    expect(screen.getByTestId('loop-log-resolution').textContent).toBe('Needs you');
  });

  it.each([
    ['resumed', 'Resumed'],
    ['rejected', 'Rejected'],
  ] as const)('shows a %s run as %s', (outcome, label) => {
    renderLog([event({ resolution: { outcome, by: 'u1', at: '2026-10-29T11:00:00.000Z' } })]);
    expect(screen.getByTestId('loop-log-resolution').textContent).toBe(label);
  });

  it('shows a scheduler resume with its reason', () => {
    const onViewRun = vi.fn();
    renderLog(
      [event({ kind: 'auto_resumed', reason: 'Daily budget reset', iteration: undefined, confidence: undefined })],
      onViewRun
    );
    expect(screen.getByTestId('loop-log-resolution').textContent).toBe('Auto-resumed');
    expect(screen.getByTestId('loop-log-row').textContent).toContain('Daily budget reset');
    fireEvent.click(screen.getByTestId('loop-log-view-run-btn'));
    expect(onViewRun).toHaveBeenCalledWith('exec-1');
  });

  it('opens the run from "View run"', () => {
    const onViewRun = vi.fn();
    renderLog([event()], onViewRun);
    fireEvent.click(screen.getByTestId('loop-log-view-run-btn'));
    expect(onViewRun).toHaveBeenCalledWith('exec-1');
  });
});

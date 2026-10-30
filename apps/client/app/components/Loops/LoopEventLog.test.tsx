import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ILoopDirectiveRow, ILoopEventRow, ILoopUnsureRow } from '@client/app/hooks/data/loops';
import LoopEventLog from './LoopEventLog';

const appTheme = extendTheme({ ...getThemeConfig() });

const event = (overrides: Partial<ILoopUnsureRow> = {}): ILoopUnsureRow => ({
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

  it('opens the run from "View run"', () => {
    const onViewRun = vi.fn();
    renderLog([event()], onViewRun);
    fireEvent.click(screen.getByTestId('loop-log-view-run-btn'));
    expect(onViewRun).toHaveBeenCalledWith('exec-1');
  });
});

const OVERSEER = 'loop-overseer';
const WORKER = 'loop-worker';

const directive = (overrides: Partial<ILoopDirectiveRow> = {}): ILoopDirectiveRow => ({
  id: 'd1',
  kind: 'directive',
  loopId: WORKER,
  fromLoopId: OVERSEER,
  fromLoopName: 'Lead',
  executionId: 'exec-lead',
  instruction: 'Stop writing tests',
  reason: 'They are slow',
  state: 'open',
  replies: [],
  createdAt: '2026-10-29T10:00:00.000Z',
  ...overrides,
});

describe('LoopEventLog directives', () => {
  const loops = [
    { id: OVERSEER, name: 'Lead' },
    { id: WORKER, name: 'Closer' },
  ];
  const renderDirectives = (
    data: ILoopEventRow[],
    loopId = WORKER,
    { onOverride = vi.fn(), onViewRun = vi.fn() } = {}
  ) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopEventLog data={data} loopId={loopId} loops={loops} onOverride={onOverride} onViewRun={onViewRun} />
      </CssVarsProvider>
    );

  it('labels the direction from each side', () => {
    renderDirectives([directive()], WORKER);
    expect(screen.getByTestId('loop-log-directive-direction').textContent).toContain('From Lead');
    cleanup();
    renderDirectives([directive()], OVERSEER);
    expect(screen.getByTestId('loop-log-directive-direction').textContent).toContain('To Closer');
  });

  it.each([
    ['open', 'Open', true, false],
    ['accepted', 'Accepted', true, false],
    ['pushed_back', 'Pushed back', true, true],
    ['done', 'Done', false, false],
    ['withdrawn', 'Withdrawn', false, false],
  ] as const)('shows a %s directive as %s with the right owner actions', (state, label, withdraw, overrule) => {
    renderDirectives([directive({ state })]);
    expect(screen.getByTestId('loop-log-directive-state').textContent).toBe(label);
    expect(!!screen.queryByTestId('loop-log-directive-withdraw-btn')).toBe(withdraw);
    expect(!!screen.queryByTestId('loop-log-directive-overrule-btn')).toBe(overrule);
  });

  it('shows the reply thread in order, with View run on worker replies', () => {
    const onViewRun = vi.fn();
    renderDirectives(
      [
        directive({
          state: 'open',
          replies: [
            {
              by: 'worker',
              outcome: 'pushed_back',
              note: 'Tests catch bugs',
              executionId: 'exec-w',
              at: '2026-10-29T11:00:00.000Z',
            },
            { by: 'owner', outcome: 'overruled', note: 'Do it anyway', at: '2026-10-29T12:00:00.000Z' },
          ],
        }),
      ],
      WORKER,
      { onViewRun }
    );
    const replies = screen.getAllByTestId('loop-log-directive-reply').map(reply => reply.textContent);
    expect(replies[0]).toContain('Worker pushed back: Tests catch bugs');
    expect(replies[1]).toContain('You overruled: Do it anyway');
    fireEvent.click(screen.getByRole('button', { name: 'View run' }));
    expect(onViewRun).toHaveBeenCalledWith('exec-w');
  });

  it('withdraws and overrules with an optional note', () => {
    const onOverride = vi.fn();
    renderDirectives([directive({ state: 'pushed_back' })], WORKER, { onOverride });

    fireEvent.click(screen.getByTestId('loop-log-directive-overrule-btn'));
    fireEvent.change(screen.getByTestId('loop-log-directive-note-input'), { target: { value: ' keep going ' } });
    fireEvent.click(screen.getByTestId('loop-log-directive-confirm-btn'));
    expect(onOverride).toHaveBeenLastCalledWith('d1', 'overrule', 'keep going');

    fireEvent.click(screen.getByTestId('loop-log-directive-withdraw-btn'));
    fireEvent.click(screen.getByTestId('loop-log-directive-confirm-btn'));
    expect(onOverride).toHaveBeenLastCalledWith('d1', 'withdraw', undefined);
  });
});

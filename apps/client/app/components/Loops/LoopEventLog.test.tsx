import { describe, expect, it, vi, type Mock } from 'vitest';
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

const renderLog = (data?: ILoopEventRow[], onViewRun = vi.fn(), onResolveUnsure?: Mock, resolvingUnsureId?: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopEventLog
        data={data}
        onViewRun={onViewRun}
        onResolveUnsure={onResolveUnsure}
        resolvingUnsureId={resolvingUnsureId}
      />
    </CssVarsProvider>
  );

describe('LoopEventLog', () => {
  it('shows an empty state', () => {
    renderLog([]);
    expect(screen.getByTestId('loop-log-empty')).toHaveTextContent(
      'Nothing yet. A run parks a ticket here when it asks you a question, or when its tools keep returning nothing useful. Directives between loops show here too.'
    );
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

  describe('a question a run asked', () => {
    const asked = (overrides: Partial<ILoopUnsureRow> = {}) =>
      event({ source: 'asked', iteration: undefined, confidence: undefined, reason: 'EU or US?', ...overrides });

    it('reads "Asked you" and resumes only with an answer', () => {
      const onResolve = vi.fn();
      renderLog([asked()], vi.fn(), onResolve);
      expect(screen.getByTestId('loop-log-unsure-subtitle').textContent).toMatch(/^Asked you - /);
      expect(screen.getByTestId('loop-log-row').textContent).not.toContain('confidence');

      const resume = screen.getByTestId('loop-log-unsure-resume-btn');
      expect(resume).toBeDisabled();
      fireEvent.change(screen.getByTestId('loop-log-unsure-answer-input'), { target: { value: ' EU ' } });
      expect(resume).toBeEnabled();
      fireEvent.click(resume);
      expect(onResolve).toHaveBeenLastCalledWith('e1', 'resumed', 'EU');

      fireEvent.click(screen.getByTestId('loop-log-unsure-reject-btn'));
      expect(onResolve).toHaveBeenLastCalledWith('e1', 'rejected', 'EU');
    });

    it("disables that row's buttons while its answer is saving", () => {
      renderLog([asked()], vi.fn(), vi.fn(), 'e1');
      fireEvent.change(screen.getByTestId('loop-log-unsure-answer-input'), { target: { value: 'EU' } });
      expect(screen.getByTestId('loop-log-unsure-resume-btn')).toBeDisabled();
      expect(screen.getByTestId('loop-log-unsure-reject-btn')).toBeDisabled();
    });

    it('rejects without an answer', () => {
      const onResolve = vi.fn();
      renderLog([asked()], vi.fn(), onResolve);
      fireEvent.click(screen.getByTestId('loop-log-unsure-reject-btn'));
      expect(onResolve).toHaveBeenCalledWith('e1', 'rejected', undefined);
    });

    it("shows the owner's answer once resolved, with no controls", () => {
      renderLog(
        [asked({ resolution: { outcome: 'resumed', at: '2026-10-29T11:00:00.000Z', note: 'EU **only**' } })],
        vi.fn(),
        vi.fn()
      );
      expect(screen.getByTestId('loop-log-resolution').textContent).toBe('Resumed');
      expect(screen.getByTestId('loop-log-unsure-answer').querySelector('strong')).toHaveTextContent('only');
      expect(screen.queryByTestId('loop-log-unsure-answer-input')).not.toBeInTheDocument();
    });

    it('leaves a gate-sourced row as it was: confidence subtitle, no answer box', () => {
      renderLog([event()], vi.fn(), vi.fn());
      expect(screen.getByTestId('loop-log-unsure-subtitle').textContent).toMatch(/^Unsure \(31% confidence\) - /);
      expect(screen.queryByTestId('loop-log-unsure-answer-input')).not.toBeInTheDocument();
      expect(screen.queryByTestId('loop-log-unsure-resume-btn')).not.toBeInTheDocument();
    });
  });

  it('renders an unsure reason as markdown, with safe external links and no raw HTML', () => {
    renderLog([event({ reason: '**bold**\n\n- a\n- b\n\n[x](https://e.com) <script>alert(1)</script>' })]);
    const reason = screen.getByTestId('loop-log-unsure-reason');
    expect(reason.querySelector('strong')).toHaveTextContent('bold');
    expect(reason.querySelectorAll('li')).toHaveLength(2);
    expect(reason.textContent).not.toContain('**');
    const link = reason.querySelector('a')!;
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(reason.querySelector('script')).toBeNull();
  });

  it('renders a markdown image as a link instead of loading it', () => {
    renderLog([event({ reason: '![leak](https://e.com/x.png)' })]);
    const reason = screen.getByTestId('loop-log-unsure-reason');
    expect(reason.querySelector('img')).toBeNull();
    expect(reason.querySelector('a')).toHaveAttribute('href', 'https://e.com/x.png');
    expect(reason).toHaveTextContent('leak');
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
    {
      onOverride = vi.fn(),
      onViewRun = vi.fn(),
      loopList = loops,
    }: { onOverride?: Mock; onViewRun?: Mock; loopList?: typeof loops } = {}
  ) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopEventLog data={data} loopId={loopId} loops={loopList} onOverride={onOverride} onViewRun={onViewRun} />
      </CssVarsProvider>
    );

  it('labels the direction from each side', () => {
    renderDirectives([directive()], WORKER);
    expect(screen.getByTestId('loop-log-directive-direction').textContent).toContain('From Lead');
    cleanup();
    renderDirectives([directive()], OVERSEER);
    expect(screen.getByTestId('loop-log-directive-direction').textContent).toContain('To Closer');
    cleanup();
    renderDirectives([directive()], OVERSEER, { loopList: [] });
    expect(screen.getByTestId('loop-log-directive-direction').textContent).toContain('To another loop');
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
    expect(replies[0]).toMatch(/^Worker pushed back - .*Tests catch bugs/);
    expect(replies[1]).toMatch(/^You overruled - .*Do it anyway$/);
    fireEvent.click(screen.getByTestId('loop-log-directive-view-run-btn'));
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

  it('clears the note on Cancel', () => {
    const onOverride = vi.fn();
    renderDirectives([directive({ state: 'pushed_back' })], WORKER, { onOverride });

    fireEvent.click(screen.getByTestId('loop-log-directive-withdraw-btn'));
    fireEvent.change(screen.getByTestId('loop-log-directive-note-input'), { target: { value: 'typo' } });
    fireEvent.click(screen.getByTestId('loop-log-directive-cancel-btn'));
    fireEvent.click(screen.getByTestId('loop-log-directive-overrule-btn'));
    expect((screen.getByTestId('loop-log-directive-note-input') as HTMLInputElement).value).toBe('');
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('shows an overruled directive as Overruled until the worker answers again', () => {
    const overrule = { by: 'owner' as const, outcome: 'overruled' as const, at: '2026-10-29T12:00:00.000Z' };
    const pushBack = {
      by: 'worker' as const,
      outcome: 'pushed_back' as const,
      executionId: 'exec-w',
      at: '2026-10-29T11:00:00.000Z',
    };
    renderDirectives([directive({ state: 'open', replies: [pushBack, overrule] })]);
    expect(screen.getByTestId('loop-log-directive-state').textContent).toBe('Overruled');
    cleanup();

    renderDirectives([
      directive({
        state: 'accepted',
        replies: [pushBack, overrule, { ...pushBack, outcome: 'accepted', at: '2026-10-29T13:00:00.000Z' }],
      }),
    ]);
    expect(screen.getByTestId('loop-log-directive-state').textContent).toBe('Accepted');
  });

  it('renders the instruction, reason and replies as markdown', () => {
    renderDirectives([
      directive({
        instruction: 'Do **this**\n\n- a\n- b',
        reason: 'See [docs](https://e.com)',
        replies: [{ by: 'owner', outcome: 'overruled', note: '**now**', at: '2026-10-29T12:00:00.000Z' }],
        state: 'open',
      }),
    ]);
    const instruction = screen.getByTestId('loop-log-directive-instruction');
    expect(instruction.querySelector('strong')).toHaveTextContent('this');
    expect(instruction.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByTestId('loop-log-directive-reason').querySelector('a')).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('loop-log-directive-reply-note').querySelector('strong')).toHaveTextContent('now');
  });
});

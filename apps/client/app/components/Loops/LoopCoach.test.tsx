import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LoopCoachResponse, LoopCoachTrialSide } from '@bike4mind/common';
import LoopCoach from './LoopCoach';

const useLoopCoach = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/loops', () => ({
  useLoopCoach,
  useLoopCoachAction: () => ({ mutate, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const side = (model: string, overrides: Partial<LoopCoachTrialSide> = {}): LoopCoachTrialSide => ({
  model,
  runs: 10,
  tickets: 10,
  up: 9,
  down: 1,
  creditsPerRun: 12,
  medianRunMs: 60_000,
  doneRate: 0.9,
  ...overrides,
});

const response = (overrides: Partial<LoopCoachResponse> = {}): LoopCoachResponse => ({
  suggestions: [
    {
      key: 'cheaper_model:build',
      kind: 'model',
      stage: 'build',
      title: 'Try a cheaper model for build',
      evidence: 'build: 19 of 20 rated up; small costs ~40% less per token than big',
      patch: { stageConfig: [{ stage: 'build', model: 'small' }] },
      trialable: true,
    },
    {
      key: 'remove_stage:review',
      kind: 'stage',
      stage: 'review',
      title: 'Remove the review stage',
      evidence: 'review passed 48 of 50 runs as done, and nothing came back to it',
      patch: { stages: ['build', 'done'] },
      trialable: false,
      disabledReason: 'Move its 2 tickets first',
    },
    {
      key: 'failing_tool:build:github',
      kind: 'tool',
      title: 'Check the github tool',
      evidence: 'github errored in 12 of 30 build runs',
      trialable: false,
    },
  ],
  dismissed: [{ key: 'raise_budget', reason: 'Spend is fine', at: '2026-11-01T00:00:00.000Z' }],
  versions: [
    {
      id: 'e2',
      at: '2026-11-09T00:00:00.000Z',
      reason: 'interval 30 -> 60',
      by: 'coach',
      suggestionKey: 'slower_schedule',
      undone: false,
      undoable: true,
    },
    { id: 'e1', at: '2026-11-08T00:00:00.000Z', reason: 'model a -> b', by: 'owner', undone: true, undoable: false },
  ],
  ...overrides,
});

const renderCoach = (data: LoopCoachResponse | undefined = response()) => {
  useLoopCoach.mockReturnValue({ data, isLoading: false });
  return render(<LoopCoach loopId="l1" />, { wrapper: Wrapper });
};

const cards = () => screen.getAllByTestId('loop-coach-suggestion');

describe('LoopCoach', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders each suggestion with its evidence and only the actions it allows', () => {
    renderCoach();
    expect(cards()).toHaveLength(3);
    const [model, stage, tool] = cards();
    expect(within(model).getByTestId('loop-coach-evidence')).toHaveTextContent('19 of 20 rated up');
    expect(within(model).getByTestId('loop-coach-trial-btn')).toBeInTheDocument();
    expect(within(stage).queryByTestId('loop-coach-trial-btn')).toBeNull();
    expect(within(stage).getByTestId('loop-coach-apply-btn')).toBeDisabled();
    expect(within(stage).getByTestId('loop-coach-disabled-reason')).toHaveTextContent('Move its 2 tickets first');
    expect(within(tool).queryByTestId('loop-coach-apply-btn')).toBeNull();
    expect(within(tool).getByText(/Advice only/)).toBeInTheDocument();
  });

  it('applies by key only', () => {
    renderCoach();
    fireEvent.click(within(cards()[0]).getByTestId('loop-coach-apply-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'apply', key: 'cheaper_model:build' });
  });

  it('starts a trial for the chosen ticket count, and refuses a count out of range', () => {
    renderCoach();
    const card = cards()[0];
    const input = within(card).getByTestId('loop-coach-trial-tickets-input');
    fireEvent.change(input, { target: { value: '4' } });
    expect(within(card).getByTestId('loop-coach-trial-btn')).toBeDisabled();
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(within(card).getByTestId('loop-coach-trial-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'trial', key: 'cheaper_model:build', tickets: 20 });
  });

  it('dismisses only with a reason', () => {
    renderCoach();
    const card = cards()[2];
    fireEvent.click(within(card).getByTestId('loop-coach-dismiss-btn'));
    const confirm = within(card).getByTestId('loop-coach-dismiss-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(card).getByTestId('loop-coach-dismiss-reason-input'), {
      target: { value: '  token expired, fixed  ' },
    });
    fireEvent.click(confirm);
    expect(mutate).toHaveBeenCalledWith({
      action: 'dismiss',
      key: 'failing_tool:build:github',
      reason: 'token expired, fixed',
    });
  });

  it('lists dismissed suggestions behind a toggle, with Restore', () => {
    renderCoach();
    expect(screen.queryByTestId('loop-coach-dismissed-row')).toBeNull();
    fireEvent.click(screen.getByTestId('loop-coach-dismissed-toggle'));
    expect(screen.getByTestId('loop-coach-dismissed-toggle')).toHaveTextContent('Dismissed (1)');
    expect(screen.getByTestId('loop-coach-dismissed-row')).toHaveTextContent('raise_budget: Spend is fine');
    fireEvent.click(screen.getByTestId('loop-coach-restore-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'restore', key: 'raise_budget' });
  });

  it('offers Undo on the change still in force only', () => {
    renderCoach();
    const rows = screen.getAllByTestId('loop-version-row');
    expect(rows[0]).toHaveTextContent('Settings changed by the coach: interval 30 -> 60');
    expect(rows[1]).toHaveTextContent('(undone)');
    expect(screen.getAllByTestId('loop-version-undo-btn')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('loop-version-undo-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'undo', eventId: 'e2' });
  });

  const trial = (complete: boolean): NonNullable<LoopCoachResponse['trial']> => ({
    stage: 'build',
    model: 'small',
    baselineModel: 'big',
    tickets: 10,
    startedAt: '2026-11-05T00:00:00.000Z',
    done: complete ? 10 : 4,
    complete,
    trial: side('small', { creditsPerRun: 7 }),
    baseline: side('big'),
  });

  it('shows trial progress, then the comparison at N, with Keep and Revert', () => {
    const { rerender } = renderCoach(response({ trial: trial(false) }));
    expect(screen.getByTestId('loop-coach-trial-progress')).toHaveTextContent('4 of 10 tickets');
    expect(screen.queryByTestId('loop-coach-trial-comparison')).toBeNull();

    useLoopCoach.mockReturnValue({ data: response({ trial: trial(true) }), isLoading: false });
    rerender(<LoopCoach loopId="l1" />);
    expect(screen.getByTestId('loop-coach-trial-progress')).toHaveTextContent('Trial complete: 10 of 10 tickets');
    const table = screen.getByTestId('loop-coach-trial-comparison');
    expect(table).toHaveTextContent('small (trial)');
    expect(table).toHaveTextContent('7 credits');
    expect(table).toHaveTextContent('90%');
    fireEvent.click(screen.getByTestId('loop-coach-trial-keep-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'keep' });
    fireEvent.click(screen.getByTestId('loop-coach-trial-revert-btn'));
    expect(mutate).toHaveBeenCalledWith({ action: 'revert' });
  });

  it('says so when there is nothing to suggest', () => {
    renderCoach(response({ suggestions: [], dismissed: [], versions: [] }));
    expect(screen.getByTestId('loop-coach-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('loop-coach-dismissed-toggle')).toBeNull();
  });
});

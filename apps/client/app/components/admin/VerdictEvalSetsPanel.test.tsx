import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { EvalSetDetail, EvalSetRun, EvalSetSummary } from '@client/app/utils/verdictEvalSets';

const m = vi.hoisted(() => ({
  useEvalSets: vi.fn(),
  useEvalSet: vi.fn(),
  create: vi.fn(),
  verdict: vi.fn(),
  run: vi.fn(),
}));
vi.mock('@client/app/hooks/data/verdictEvalSets', () => ({
  useEvalSets: m.useEvalSets,
  useEvalSet: m.useEvalSet,
  useCreateEvalSet: () => ({ mutateAsync: m.create, isPending: false, error: null }),
  useEvalSetVerdict: () => ({ mutateAsync: m.verdict, isPending: false, error: null, variables: undefined }),
  useRunEvalSet: () => ({ mutateAsync: m.run, isPending: false, error: null }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace('$userId', params.userId)} {...rest}>
      {children}
    </a>
  ),
}));

import { VerdictEvalSetsPanel } from './VerdictEvalSetsPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VerdictEvalSetsPanel />
    </CssVarsProvider>
  );

const WHEN = new Date('2026-11-06T12:00:00Z');
const summary: EvalSetSummary = {
  id: 's1',
  name: 'November',
  note: null,
  createdBy: 'admin',
  window: { since: WHEN, until: WHEN },
  heldOutShare: 0.5,
  population: { flagged: 3, unflagged: 900 },
  truncated: false,
  examples: 5,
  heldOutExamples: 3,
  unflaggedExamples: 2,
  labelledByVerdict: {
    confirmed_abuse: 0,
    legitimate_human: 0,
    legitimate_automation: 0,
    insufficient_evidence: 0,
  },
  runs: 2,
  lastRunAt: WHEN,
  createdAt: WHEN,
};

const score = (precision: number) => ({
  grader: 'detectors' as const,
  variant: 'any',
  truePositive: 4,
  falsePositive: 1,
  falseNegative: 1,
  trueNegative: 6,
  abstained: 0,
  precision,
  precisionLowerBound: 0.4,
  hitRate: 0.8,
  falsePositiveRate: 0.143,
});
const runOf = (precision: number): EvalSetRun => ({
  ranAt: WHEN,
  ranBy: 'admin',
  note: null,
  report: {
    split: 'heldOut',
    examples: 3,
    labelled: 3,
    scores: [score(precision)],
    recall: {
      flaggedAbuse: 4,
      sampledUnflaggedAbuse: 1,
      sampledUnflagged: 2,
      unflaggedPopulation: 450,
      estimatedMissedAbuse: 225,
      estimatedRecall: 0.017,
    },
    cohorts: [
      {
        cohort: 'mobile',
        measurable: true,
        flaggedAccounts: 2,
        labelledAccounts: 2,
        abuse: 1,
        legit: 1,
        falsePositiveShare: 0.5,
      },
      {
        cohort: 'assistive',
        measurable: false,
        flaggedAccounts: 0,
        labelledAccounts: 0,
        abuse: 0,
        legit: 0,
        falsePositiveShare: null,
      },
    ],
    labelSources: { adminVerdict: 3 },
  },
});

const example = (userId: string, overrides: Partial<EvalSetDetail['examples'][number]> = {}) => ({
  userId,
  kind: 'unflagged' as const,
  split: 'heldOut' as const,
  detectionIds: [],
  campaignKey: userId,
  cohorts: [],
  signedUpAt: WHEN,
  currentLabel: null,
  latestVerdict: null,
  revision: 0,
  ...overrides,
});
const detail: EvalSetDetail = {
  id: 's1',
  name: 'November',
  note: null,
  createdBy: 'admin',
  window: summary.window,
  heldOutShare: 0.5,
  population: summary.population,
  truncated: false,
  createdAt: WHEN,
  examples: [
    example('labelled-flagged', { kind: 'flagged', currentLabel: { label: 'abuse', source: 'frozen' } }),
    example('needs-label'),
  ],
  runs: [runOf(0.7), runOf(0.8)],
  runCount: 2,
};

beforeEach(() => {
  Object.values(m).forEach(fn => fn.mockReset());
  m.useEvalSets.mockReturnValue({ data: [summary], isPending: false, error: null, refetch: vi.fn() });
  m.useEvalSet.mockReturnValue({ data: detail, isPending: false, error: null, refetch: vi.fn() });
});

describe('VerdictEvalSetsPanel', () => {
  it('lists sets with their denominators', () => {
    renderPanel();
    const table = screen.getByTestId('eval-sets-table');
    expect(within(table).getByText('November')).toBeTruthy();
    expect(within(table).getByText('3 / 900')).toBeTruthy();
    expect(within(table).getByText('3 of 5')).toBeTruthy();
  });

  it('shows an empty state that points at the form', () => {
    m.useEvalSets.mockReturnValue({ data: [], isPending: false, error: null, refetch: vi.fn() });
    renderPanel();
    expect(screen.getByText('No evaluation sets yet')).toBeTruthy();
    expect(screen.getByTestId('eval-sets-empty-btn')).toBeTruthy();
  });

  it('retries a failed list', () => {
    const refetch = vi.fn();
    m.useEvalSets.mockReturnValue({ data: undefined, isPending: false, error: new Error('boom'), refetch });
    renderPanel();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('draws a set from the form and selects it', async () => {
    m.create.mockResolvedValue('s1');
    renderPanel();
    expect((screen.getByTestId('eval-sets-create-btn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('eval-sets-name-input'), { target: { value: ' Week 45 ' } });
    fireEvent.click(screen.getByTestId('eval-sets-create-btn'));

    await waitFor(() =>
      expect(m.create).toHaveBeenCalledWith({ name: 'Week 45', days: 30, unflaggedSample: 200, heldOutShare: 0.5 })
    );
    await waitFor(() => expect(screen.getByTestId('eval-sets-detail')).toBeTruthy());
  });

  describe('selected set', () => {
    const open = () => {
      renderPanel();
      fireEvent.click(within(screen.getByTestId('eval-sets-table')).getByText('November'));
    };

    it('shows the latest run against the previous one, with the recall inputs and cohorts', () => {
      open();
      const scores = screen.getByTestId('eval-sets-run-scores');
      expect(within(scores).getByText('80% (40%) (+10 pts)')).toBeTruthy();
      expect(within(scores).getByText('80% of 5 (+0 pts)')).toBeTruthy();
      expect(screen.getByText('Estimated recall')).toBeTruthy();
      expect(screen.getByText(/1 abuse in 2 labelled unflagged, scaled to 450 accounts/)).toBeTruthy();
      expect(
        within(screen.getByTestId('eval-sets-cohorts')).getByText('Not measurable: no stored signal')
      ).toBeTruthy();
    });

    it('lists unlabelled examples first with a link to the account', () => {
      open();
      const rows = within(screen.getByTestId('eval-sets-examples')).getAllByRole('row');
      expect(rows[1].textContent).toContain('needs-label');
      expect(rows[2].textContent).toContain('abuse (frozen at draw)');
      expect(screen.getByTestId('eval-sets-user-link-needs-label').getAttribute('href')).toBe(
        '/admin/users/needs-label'
      );
    });

    it('keeps the save button off until there is a verdict and a reason', () => {
      open();
      const save = screen.getByTestId('eval-sets-verdict-btn-needs-label') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(screen.getByTestId('eval-sets-reason-input-needs-label'), { target: { value: 'looks real' } });
      expect(save.disabled).toBe(true);
    });

    it('runs the set with its note', async () => {
      m.run.mockResolvedValue({});
      open();
      fireEvent.change(screen.getByTestId('eval-sets-run-note-input'), { target: { value: 'retuned' } });
      fireEvent.click(screen.getByTestId('eval-sets-run-btn'));
      await waitFor(() => expect(m.run).toHaveBeenCalledWith({ note: 'retuned' }));
    });

    it('says when a set has not been run', () => {
      m.useEvalSet.mockReturnValue({
        data: { ...detail, runs: [], runCount: 0 },
        isPending: false,
        error: null,
        refetch: vi.fn(),
      });
      open();
      expect(screen.getByTestId('eval-sets-no-run')).toBeTruthy();
    });
  });
});

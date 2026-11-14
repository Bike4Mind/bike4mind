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
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
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
  hitRate: null,
  falsePositiveRate: null,
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
      flaggedExamples: 5,
      flaggedReviewed: 5,
      flaggedAbuse: 4,
      flaggedPopulation: 5,
      unflaggedExamples: 2,
      unflaggedReviewed: 2,
      unflaggedAbuse: 1,
      unflaggedPopulation: 450,
      minimumReviewed: 30,
      estimatedFlaggedAbuse: 4,
      estimatedMissedAbuse: 225,
      estimatedRecall: 0.017,
      recallWithheld: null,
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
    calibration: [
      {
        model: 'm1',
        flaggedLabelled: 4,
        n: 3,
        brier: 0.12,
        buckets: [
          { lower: 0, upper: 0.2, n: 1, meanPredicted: 0.1, observedAbuseRate: 0 },
          { lower: 0.2, upper: 0.4, n: 0, meanPredicted: null, observedAbuseRate: null },
          { lower: 0.4, upper: 0.6, n: 0, meanPredicted: null, observedAbuseRate: null },
          { lower: 0.6, upper: 0.8, n: 0, meanPredicted: null, observedAbuseRate: null },
          { lower: 0.8, upper: 1, n: 2, meanPredicted: 0.9, observedAbuseRate: 1 },
        ],
      },
    ],
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
    example('needs-label', { revision: 3 }),
    example('inconclusive', {
      latestVerdict: {
        verdict: 'insufficient_evidence',
        reason: 'not enough',
        reviewerId: 'rev-1',
        reviewedAt: WHEN,
      },
    }),
    example('conclusive', {
      currentLabel: { label: 'legit', source: 'verdict' },
      latestVerdict: { verdict: 'legitimate_human', reason: 'real person', reviewerId: 'rev-2', reviewedAt: WHEN },
    }),
    example('tuning-unlabelled', { split: 'tuning' }),
    example('flagged-before-window', {
      kind: 'flagged',
      signedUpAt: new Date('2026-09-01T00:00:00Z'),
      currentLabel: { label: 'abuse', source: 'frozen' },
    }),
  ],
  runs: [runOf(0.7), runOf(0.8)],
  runCount: 2,
  unreadableRunCount: 0,
};

beforeEach(() => {
  m.currentUser = { isAdmin: true };
  [m.useEvalSets, m.useEvalSet, m.create, m.verdict, m.run].forEach(fn => fn.mockReset());
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
      expect(screen.getByText('Estimated recall')).toBeTruthy();
      expect(
        screen.getByText(/1 abuse in 2 reviewed unflagged held-out examples, scaled to 450 accounts/)
      ).toBeTruthy();
      expect(screen.getByTestId('eval-sets-scores-note').textContent).toContain('Recall comes from the estimate');
      expect(screen.queryByTestId('eval-sets-unreadable-runs')).toBeNull();
      expect(within(scores).queryByText('Hit rate (of abuse)')).toBeNull();
      expect(
        within(screen.getByTestId('eval-sets-cohorts')).getByText('Not measurable: no stored signal')
      ).toBeTruthy();
    });

    it('orders recall examples on both sides without a conclusive verdict first, with a link to the account', () => {
      open();
      const rows = within(screen.getByTestId('eval-sets-examples')).getAllByRole('row');
      const order = rows.slice(1).map(row => row.textContent ?? '');
      // A frozen label does not count toward recall, so an in-window flagged example still needs a verdict.
      expect(order[0]).toContain('labelled-flagged');
      expect(order[1]).toContain('needs-label');
      expect(order[2]).toContain('inconclusive');
      expect(order[3]).toContain('tuning-unlabelled');
      expect(order[4]).toContain('legit (verdict)');
      expect(order[5]).toContain('flagged-before-window');
      expect(screen.getByTestId('eval-sets-user-link-needs-label').getAttribute('href')).toBe(
        '/admin/users/needs-label'
      );
    });

    it('shows the latest verdict and says insufficient evidence leaves the example unlabelled', () => {
      open();
      const table = screen.getByTestId('eval-sets-examples');
      expect(within(table).getByText(/Legitimate human, by rev-2/)).toBeTruthy();
      expect(
        within(table).getByText(/Leaves the example unlabelled, overriding any label frozen at draw/)
      ).toBeTruthy();
    });

    it('explains a withheld recall estimate', () => {
      const withheld = runOf(0.8);
      withheld.report.recall = {
        ...withheld.report.recall,
        estimatedRecall: null,
        estimatedMissedAbuse: null,
        recallWithheld: 'too_few_unflagged_reviews',
        unflaggedReviewed: 12,
      };
      m.useEvalSet.mockReturnValue({
        data: { ...detail, runs: [withheld] },
        isPending: false,
        error: null,
        refetch: vi.fn(),
      });
      open();
      expect(screen.getByText('Needs at least 30 reviewed unflagged held-out examples; 12 so far.')).toBeTruthy();
    });

    it('explains recall withheld for too few flagged reviews', () => {
      const withheld = runOf(0.8);
      withheld.report.recall = {
        ...withheld.report.recall,
        estimatedRecall: null,
        recallWithheld: 'too_few_flagged_reviews',
        flaggedReviewed: 7,
      };
      m.useEvalSet.mockReturnValue({
        data: { ...detail, runs: [withheld] },
        isPending: false,
        error: null,
        refetch: vi.fn(),
      });
      open();
      expect(screen.getByText('Needs at least 30 reviewed flagged held-out examples; 7 so far.')).toBeTruthy();
    });

    const withRuns = (...runs: EvalSetRun[]) =>
      m.useEvalSet.mockReturnValue({ data: { ...detail, runs }, isPending: false, error: null, refetch: vi.fn() });

    it("shows each assessment model's calibration, and says when a model has too few assessed examples", () => {
      const latest = runOf(0.8);
      latest.report.calibration = [
        { ...latest.report.calibration[0], n: 40 },
        { model: 'm2', flaggedLabelled: 4, n: 0, brier: null, buckets: [] },
      ];
      withRuns(latest);
      open();
      const table = screen.getByTestId('eval-sets-calibration-table');
      expect(within(table).getByText('40 of 4')).toBeTruthy();
      expect(within(table).getByText('0.120')).toBeTruthy();
      expect(within(table).getByText('90% vs 100% (2)')).toBeTruthy();
      expect(within(table).getByText('Not enough assessed examples (0 of 4)')).toBeTruthy();
    });

    it('labels the buckets with which side of each boundary they include', () => {
      open();
      const table = screen.getByTestId('eval-sets-calibration-table');
      for (const label of ['[0, 20)%', '[20, 40)%', '[40, 60)%', '[60, 80)%', '[80, 100]%']) {
        expect(within(table).getByText(label)).toBeTruthy();
      }
    });

    it('keeps the buckets but withholds the Brier score below the minimum reviewed', () => {
      open();
      const table = screen.getByTestId('eval-sets-calibration-table');
      expect(within(table).getByText('90% vs 100% (2)')).toBeTruthy();
      expect(within(table).queryByText('0.120')).toBeNull();
      expect(screen.getByTestId('eval-sets-calibration-too-few-m1').textContent).toBe(
        'm1: Too few examples for a Brier score (3 of 30)'
      );
    });

    it('says a run without calibration may predate it when it has assessment scores', () => {
      const latest = runOf(0.8);
      latest.report.scores = [{ ...score(0.8), grader: 'assessment', variant: 'm1' }];
      latest.report.calibration = [];
      withRuns(latest);
      open();
      expect(
        screen.getByText('No assessment calibration in this run (runs before calibration was added have none).')
      ).toBeTruthy();
    });

    it('keeps the plain empty message when the run has no assessment scores', () => {
      const latest = runOf(0.8);
      latest.report.calibration = [];
      withRuns(latest);
      open();
      expect(screen.getByText('No assessment calibration in this run.')).toBeTruthy();
    });

    it('shows the risk-review share and its caveat only when the run has risk-review labels', () => {
      open();
      expect(screen.getByTestId('eval-sets-label-sources').textContent).toContain('Detection verdict 3');
      expect(screen.queryByTestId('eval-sets-risk-review-caveat')).toBeNull();
    });

    it('warns that risk-review labels only cover accounts the risk queue flagged before', () => {
      const latest = runOf(0.8);
      latest.report.labelSources = { adminVerdict: 3, riskReview: 1 };
      withRuns(latest);
      open();
      const caveat = screen.getByTestId('eval-sets-risk-review-caveat').textContent ?? '';
      expect(caveat).toContain('25% of labels (1 of 4) come from risk review');
      expect(caveat).toContain('never flagged');
    });

    it('compares the run with the previous one, row by row', () => {
      const previous = runOf(0.7);
      previous.report.calibration = [{ ...previous.report.calibration[0], n: 40, brier: 0.15 }];
      const latest = runOf(0.8);
      latest.report.calibration = [{ ...latest.report.calibration[0], n: 40 }];
      latest.report.scores = [
        { ...score(0.8), truePositive: 6 },
        { ...score(0.5), grader: 'assessment', variant: 'm1' },
      ];
      latest.report.labelled = 5;
      withRuns(previous, latest);
      open();
      const summary = screen.getByTestId('eval-sets-run-comparison-summary').textContent ?? '';
      expect(summary).toContain('Labelled examples: 5 (+2)');
      expect(summary).toContain('estimated recall: 2% (0 pts)');
      expect(summary).toContain('Brier, m1: 0.120 (-0.030)');
      const rows = within(screen.getByTestId('eval-sets-run-comparison-scores')).getAllByRole('row');
      const text = rows.slice(1).map(row => row.textContent ?? '');
      expect(text[0]).toContain('Detectors, any');
      expect(text[0]).toContain('+2');
      expect(text[0]).toContain('0 pts');
      expect(text[1]).toContain('AI assessment, m1 (new in this run)');
    });

    it('hides the Brier change while either run has too few assessed examples', () => {
      const previous = runOf(0.7);
      previous.report.calibration = [{ ...previous.report.calibration[0], brier: 0.15 }];
      withRuns(previous, runOf(0.8));
      open();
      const summary = screen.getByTestId('eval-sets-run-comparison-summary').textContent ?? '';
      expect(summary).toContain('Brier, m1: - (-)');
    });

    it('shows no comparison without a previous run', () => {
      withRuns(runOf(0.8));
      open();
      expect(screen.queryByTestId('eval-sets-run-comparison')).toBeNull();
    });

    it('says how many stored runs could not be read', () => {
      m.useEvalSet.mockReturnValue({
        data: { ...detail, runCount: 4, unreadableRunCount: 2 },
        isPending: false,
        error: null,
        refetch: vi.fn(),
      });
      open();
      expect(screen.getByTestId('eval-sets-unreadable-runs').textContent).toBe('2 stored runs could not be read.');
    });

    const openLabelDialog = async (userId: string) => {
      open();
      fireEvent.click(screen.getByTestId(`eval-sets-label-btn-${userId}`));
      return screen.findByTestId('eval-sets-label-dialog');
    };

    it('labels an example with the verdict, the reason and the revision it was read at', async () => {
      m.verdict.mockResolvedValue(undefined);
      const dialog = await openLabelDialog('needs-label');
      fireEvent.click(within(dialog).getByTestId('eval-sets-verdict-option-confirmed_abuse'));
      fireEvent.change(within(dialog).getByTestId('eval-sets-label-dialog-reason-input'), {
        target: { value: 'looks like a farm' },
      });
      fireEvent.click(within(dialog).getByTestId('eval-sets-label-dialog-confirm-btn'));
      await waitFor(() =>
        expect(m.verdict).toHaveBeenCalledWith({
          userId: 'needs-label',
          verdict: 'confirmed_abuse',
          reason: 'looks like a farm',
          expectedRevision: 3,
        })
      );
      await waitFor(() => expect(screen.queryByTestId('eval-sets-label-dialog')).toBeNull());
    });

    it('does not record a label whose reason is too short', async () => {
      const dialog = await openLabelDialog('needs-label');
      fireEvent.click(within(dialog).getByTestId('eval-sets-verdict-option-confirmed_abuse'));
      fireEvent.change(within(dialog).getByTestId('eval-sets-label-dialog-reason-input'), { target: { value: 'no' } });
      expect((within(dialog).getByTestId('eval-sets-label-dialog-confirm-btn') as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(m.verdict).not.toHaveBeenCalled();
    });

    it('names the account when someone else labelled it first and keeps the dialog open', async () => {
      m.verdict.mockRejectedValue({
        isAxiosError: true,
        response: { status: 409, data: { message: 'This example was labelled by someone else. Review it again.' } },
      });
      const dialog = await openLabelDialog('needs-label');
      fireEvent.click(within(dialog).getByTestId('eval-sets-verdict-option-legitimate_human'));
      fireEvent.change(within(dialog).getByTestId('eval-sets-label-dialog-reason-input'), {
        target: { value: 'real person' },
      });
      fireEvent.click(within(dialog).getByTestId('eval-sets-label-dialog-confirm-btn'));
      const conflict = await screen.findByTestId('eval-sets-conflict');
      expect(conflict.textContent).toContain('needs-label');
      expect(conflict.textContent).toContain('labelled by someone else');
      expect(screen.getByTestId('eval-sets-label-dialog')).toBeTruthy();
    });

    it('shows the server message for other failures', async () => {
      m.verdict.mockRejectedValue({
        isAxiosError: true,
        response: { status: 404, data: { message: 'Example not found' } },
      });
      const dialog = await openLabelDialog('needs-label');
      fireEvent.click(within(dialog).getByTestId('eval-sets-verdict-option-legitimate_human'));
      fireEvent.change(within(dialog).getByTestId('eval-sets-label-dialog-reason-input'), {
        target: { value: 'real person' },
      });
      fireEvent.click(within(dialog).getByTestId('eval-sets-label-dialog-confirm-btn'));
      expect((await screen.findByTestId('eval-sets-verdict-error')).textContent).toBe('Example not found');
    });

    it('opens the dialog for the clicked account only', async () => {
      const dialog = await openLabelDialog('inconclusive');
      expect(within(dialog).getByText(/Latest verdict: Insufficient evidence/)).toBeTruthy();
      expect(within(dialog).getAllByText('inconclusive').length).toBeGreaterThan(0);
      expect(within(dialog).queryByText('needs-label')).toBeNull();
    });

    it('disables every write control without the moderate permission', () => {
      m.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
      open();
      expect((screen.getByTestId('eval-sets-label-btn-needs-label') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId('eval-sets-run-btn') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByTestId('eval-sets-name-input'), { target: { value: 'Week 45' } });
      expect((screen.getByTestId('eval-sets-create-btn') as HTMLButtonElement).disabled).toBe(true);
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

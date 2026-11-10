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
  ],
  runs: [runOf(0.7), runOf(0.8)],
  runCount: 2,
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
      expect(within(scores).queryByText('Hit rate (of abuse)')).toBeNull();
      expect(
        within(screen.getByTestId('eval-sets-cohorts')).getByText('Not measurable: no stored signal')
      ).toBeTruthy();
    });

    it('orders held-out unflagged examples without a conclusive verdict first, with a link to the account', () => {
      open();
      const rows = within(screen.getByTestId('eval-sets-examples')).getAllByRole('row');
      const order = rows.slice(1).map(row => row.textContent ?? '');
      expect(order[0]).toContain('needs-label');
      expect(order[1]).toContain('inconclusive');
      expect(order[2]).toContain('tuning-unlabelled');
      expect(order[3]).toContain('abuse (frozen at draw)');
      expect(order[4]).toContain('legit (verdict)');
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

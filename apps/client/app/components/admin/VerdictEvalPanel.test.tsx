import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { VerdictEvalReport } from '@client/app/utils/verdictEval';

const m = vi.hoisted(() => ({ useVerdictEval: vi.fn() }));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({ useVerdictEval: m.useVerdictEval }));

vi.mock('./VerdictEvalSetsPanel', () => ({ VerdictEvalSetsPanel: () => <div data-testid="eval-sets-panel" /> }));

import { VerdictEvalPanel } from './VerdictEvalPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VerdictEvalPanel />
    </CssVarsProvider>
  );

const report: VerdictEvalReport = {
  since: new Date('2026-10-07T00:00:00Z'),
  detections: 4,
  labelledDetections: 2,
  labelledAccounts: 4,
  excludedAutoApprovals: 3,
  operations: [
    {
      detector: 'accountCampaign',
      detections: 4,
      reviewed: 3,
      conclusive: 2,
      reviewYield: 0.5,
      timeToDetection: { n: 2, medianHours: 5, p90Hours: 6 },
      spend: { accounts: 3, creditsBeforeDetection: 17, creditsAfterDetection: 14 },
    },
  ],
  cohorts: [
    {
      cohort: 'mobile',
      measurable: true,
      flaggedAccounts: 4,
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
  scores: [
    {
      grader: 'signupVerdict',
      variant: 'chart',
      truePositive: 1,
      falsePositive: 0,
      falseNegative: 2,
      trueNegative: 1,
      abstained: 0,
      precision: 1,
      hitRate: 0.333,
      falsePositiveRate: 0,
    },
  ],
  disagreements: [
    {
      grader: 'signupVerdict',
      variant: 'chart',
      kind: 'falseNegative',
      detectionId: null,
      userId: 'farm-1',
      predicted: 'legit',
      label: 'abuse',
      labelSource: 'adminSuspended',
      confidence: null,
      at: new Date('2026-11-05T14:43:00Z'),
    },
  ],
  truncated: false,
};

beforeEach(() => {
  m.useVerdictEval.mockReset();
  m.useVerdictEval.mockReturnValue({ data: report, error: null, refetch: vi.fn() });
});

describe('VerdictEvalPanel', () => {
  it('shows each grader score and the abuse it missed', () => {
    renderPanel();

    const strip = screen.getByTestId('verdict-eval-score-signupVerdict-chart');
    expect(within(strip).getByText('Signup verdict, chart')).toBeTruthy();
    expect(within(strip).getByText('33%')).toBeTruthy();
    expect(within(strip).getByText('2 abuse missed')).toBeTruthy();
    const table = screen.getByTestId('verdict-eval-disagreements');
    expect(within(table).getByText('Missed abuse')).toBeTruthy();
    expect(within(table).getByText('abuse (Suspended by an admin)')).toBeTruthy();
    expect(within(table).getByText('farm-1')).toBeTruthy();
  });

  it('shows operations per detector and the cohorts with their denominators', () => {
    renderPanel();

    const operations = screen.getByTestId('verdict-eval-operations');
    expect(within(operations).getByText('accountCampaign')).toBeTruthy();
    expect(within(operations).getByText('50% of 2')).toBeTruthy();
    expect(within(operations).getByText('5 / 6 (2)')).toBeTruthy();
    expect(within(operations).getByText('17 / 14 (3 accounts)')).toBeTruthy();
    const cohorts = screen.getByTestId('verdict-eval-cohorts');
    expect(within(cohorts).getByText('Mobile or tablet')).toBeTruthy();
    expect(within(cohorts).getByText('2 of 4')).toBeTruthy();
    expect(within(cohorts).getByText('50% of 2')).toBeTruthy();
    expect(within(cohorts).getByText('Not measurable: no stored signal')).toBeTruthy();
    expect(screen.getByTestId('verdict-eval-auto-approvals').textContent).toContain('3 accounts approved');
  });

  it('starts at 30 days and switches the window', () => {
    renderPanel();
    expect(m.useVerdictEval).toHaveBeenLastCalledWith(30);

    fireEvent.click(screen.getByTestId('verdict-eval-window-90'));

    expect(m.useVerdictEval).toHaveBeenLastCalledWith(90);
  });

  it('says when nothing is labelled yet', () => {
    m.useVerdictEval.mockReturnValue({
      data: { ...report, scores: [], disagreements: [] },
      error: null,
      refetch: vi.fn(),
    });
    renderPanel();

    expect(screen.getByTestId('verdict-eval-empty').textContent).toBe('No labelled verdicts in the last 30 days.');
  });
});

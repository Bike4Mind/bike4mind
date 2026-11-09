import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { VerdictEvalReport } from '@client/app/utils/verdictEval';

const m = vi.hoisted(() => ({ useVerdictEval: vi.fn() }));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({ useVerdictEval: m.useVerdictEval }));

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

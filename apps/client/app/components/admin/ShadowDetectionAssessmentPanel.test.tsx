// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AbuseAssessmentRow } from '@client/app/hooks/data/shadowDetections';
import { ShadowDetectionAssessmentPanel } from './ShadowDetectionAssessmentPanel';

const hooks = vi.hoisted(() => ({
  useAbuseAssessments: vi.fn(),
  useRequestAbuseAssessment: vi.fn(),
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => hooks);

const DETECTION_ID = 'a'.repeat(24);
const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ShadowDetectionAssessmentPanel detectionId={DETECTION_ID} enabled />
    </CssVarsProvider>
  );

const makeItem = (overrides: Partial<AbuseAssessmentRow> = {}): AbuseAssessmentRow =>
  ({
    id: 'one',
    detectionId: DETECTION_ID,
    result: 'abuse',
    probabilities: [
      { value: 'abuse', probability: 0.7 },
      { value: 'legitimate_automation', probability: 0.2 },
      { value: 'insufficient_evidence', probability: 0.1 },
    ],
    confidence: 0.7,
    model: 'jev',
    modelVersion: 'v1',
    policyVersion: 1,
    evidenceVersion: 1,
    evidenceHash: 'h',
    featureSummary: { accounts: [] },
    failure: null,
    attempts: 1,
    costUsd: 0,
    trigger: 'admin',
    requestedBy: null,
    assessedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as AbuseAssessmentRow;

const mutateAsync = vi.fn();

describe('ShadowDetectionAssessmentPanel', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    hooks.useAbuseAssessments.mockReturnValue({ data: [makeItem()], isPending: false, error: null });
    hooks.useRequestAbuseAssessment.mockReturnValue({ mutateAsync, isPending: false, error: null });
  });

  it('renders the latest result and its probabilities', () => {
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-result').textContent).toContain('Abuse');
    const list = screen.getByTestId('shadow-detection-assessment-probabilities').textContent;
    expect(list).toContain('Abuse: 70%');
    expect(list).toContain('Legitimate automation: 20%');
    expect(screen.getByTestId('shadow-detection-assessment-confidence').textContent).toContain('70%');
  });

  it('renders unknown with its failure in plain words', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [makeItem({ result: 'unknown', probabilities: [], confidence: null, failure: 'provider_overloaded' })],
      isPending: false,
      error: null,
    });
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-result').textContent).toContain('Unknown');
    expect(screen.getByTestId('shadow-detection-assessment-failure').textContent).toContain('overloaded');
  });

  it('requests an assessment when Assess now is clicked', async () => {
    mutateAsync.mockResolvedValue({ status: 'assessed', cached: true, item: makeItem() });
    renderPanel();
    fireEvent.click(screen.getByTestId('shadow-detection-assess-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(DETECTION_ID));
    expect((await screen.findByTestId('shadow-detection-assessment-outcome')).textContent).toContain('reused');
  });

  it('shows the reason when the assessment is skipped', async () => {
    mutateAsync.mockResolvedValue({ status: 'skipped', reason: 'disabled' });
    renderPanel();
    fireEvent.click(screen.getByTestId('shadow-detection-assess-btn'));
    expect((await screen.findByTestId('shadow-detection-assessment-outcome')).textContent).toContain(
      'off in admin settings'
    );
  });
});

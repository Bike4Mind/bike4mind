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
  currentUser: { adminPermissions: ['support:read', 'users:moderate'] } as { adminPermissions: string[] },
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => hooks);
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: hooks.currentUser }) }));

const DETECTION_ID = 'a'.repeat(24);
const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = (props: Partial<React.ComponentProps<typeof ShadowDetectionAssessmentPanel>> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ShadowDetectionAssessmentPanel detectionId={DETECTION_ID} enabled {...props} />
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
    hooks.currentUser = { adminPermissions: ['support:read', 'users:moderate'] };
    hooks.useAbuseAssessments.mockReturnValue({ data: [makeItem()], isPending: false, error: null });
    hooks.useRequestAbuseAssessment.mockReturnValue({ mutateAsync, isPending: false, error: null });
  });

  it('renders the latest result and its probabilities', () => {
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-suggestion-proposal').textContent).toBe('Confirmed abuse');
    const list = screen.getByTestId('shadow-detection-assessment-probabilities').textContent;
    expect(list).toContain('Abuse: 70%');
    expect(list).toContain('Legitimate automation: 20%');
    expect(screen.getByTestId('shadow-detection-assessment-suggestion-confidence').textContent).toContain('Medium');
  });

  it('words the suggestion from the proposed result probability, and dates it once', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [
        makeItem({
          probabilities: [
            { value: 'abuse', probability: 0.85 },
            { value: 'legitimate_automation', probability: 0.1 },
            { value: 'insufficient_evidence', probability: 0.05 },
          ],
          confidence: 0.6,
        }),
      ],
      isPending: false,
      error: null,
    });
    renderPanel();
    const word = screen.getByTestId('shadow-detection-assessment-suggestion-confidence');
    expect(word.textContent).toContain('High');
    expect(word).toHaveAttribute('data-confidence', 'high');
    expect(screen.queryByTestId('shadow-detection-assessment-suggestion-meta')).toBeNull();
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

  it('shows no suggestion for an unknown result', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [makeItem({ result: 'unknown', confidence: null, probabilities: [] })],
      isPending: false,
      error: null,
    });
    renderPanel({ onAccept: vi.fn() });
    expect(screen.queryByTestId('shadow-detection-assessment-suggestion')).toBeNull();
  });

  it('hands the proposed verdict to the host on Accept, and offers no buttons without a host', () => {
    const onAccept = vi.fn();
    const { unmount } = renderPanel({ onAccept, onOverride: vi.fn() });
    fireEvent.click(screen.getByTestId('shadow-detection-assessment-suggestion-accept-btn'));
    expect(onAccept).toHaveBeenCalledWith('confirmed_abuse');
    unmount();
    renderPanel();
    expect(screen.queryByTestId('shadow-detection-assessment-suggestion-accept-btn')).toBeNull();
  });

  it('requests an assessment when Assess now is clicked', async () => {
    mutateAsync.mockResolvedValue({ status: 'assessed', cached: true, item: makeItem() });
    renderPanel();
    fireEvent.click(screen.getByTestId('shadow-detection-assess-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(DETECTION_ID));
    expect((await screen.findByTestId('shadow-detection-assessment-outcome')).textContent).toContain('reused');
  });

  it('hides Assess now from a support-only admin', () => {
    hooks.currentUser = { adminPermissions: ['support:read'] };
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-suggestion')).toBeTruthy();
    expect(screen.queryByTestId('shadow-detection-assess-btn')).toBeNull();
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

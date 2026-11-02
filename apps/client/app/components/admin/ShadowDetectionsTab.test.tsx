import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ShadowDetectionSummaryRow } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ShadowDetectionListResponse, ShadowDetectionRow } from '@client/app/hooks/data/shadowDetections';

// The data hooks are mocked so each path is driven directly.
const m = vi.hoisted(() => ({
  useShadowDetections: vi.fn(),
  mutateAsync: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({
  useShadowDetections: m.useShadowDetections,
  useShadowDetectionVerdict: () => ({ mutateAsync: m.mutateAsync, isPending: false, error: null }),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => m.search,
  useNavigate: () => m.navigate,
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

import ShadowDetectionsTab from './ShadowDetectionsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ShadowDetectionsTab />
    </CssVarsProvider>
  );

const DETECTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const detection = (over: Partial<ShadowDetectionRow> = {}): ShadowDetectionRow => ({
  id: DETECTION_ID,
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 signups from one IP in 180 minutes',
  userIds: ['bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc'],
  network: { ip: '203.0.113.7', asn: 64500, asnOrg: 'Example Hosting', country: 'NL', hosting: true },
  signals: [{ key: 'signups', label: 'Signups from one IP', observed: 3, threshold: 3 }],
  windowMinutes: 180,
  detectedAt: '2026-10-30T10:00:00.000Z',
  verdict: null,
  verdicts: [],
  revision: 4,
  ...over,
});

const summaryRow = (over: Partial<ShadowDetectionSummaryRow> = {}): ShadowDetectionSummaryRow => ({
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  recorded: 20,
  confirmedAbuse: 9,
  legitimateHuman: 2,
  legitimateAutomation: 1,
  insufficientEvidence: 3,
  ...over,
});

const list = (over: Partial<ShadowDetectionListResponse> = {}): ShadowDetectionListResponse => ({
  data: [detection()],
  truncated: false,
  summary: [summaryRow()],
  ...over,
});

const queryResult = (data: ShadowDetectionListResponse) => ({
  data,
  isPending: false,
  error: null,
  refetch: vi.fn(),
});

describe('ShadowDetectionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.search = {};
    m.useShadowDetections.mockReturnValue(queryResult(list()));
  });

  it('defaults to unreviewed detections and renders rows and stats', () => {
    renderTab();

    expect(m.useShadowDetections).toHaveBeenCalledWith({ detector: undefined, verdict: 'unreviewed' });
    const row = screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`);
    expect(within(row).getByText('3 signups from one IP in 180 minutes')).toBeTruthy();
    expect(within(row).getByText('Contain')).toBeTruthy();
    expect(within(row).getByText('Unreviewed')).toBeTruthy();
    expect(within(row).getByText('203.0.113.7 / Example Hosting / NL / Hosting')).toBeTruthy();
    expect(
      screen.getByTestId(`shadow-detection-user-link-${DETECTION_ID}-bbbbbbbbbbbbbbbbbbbbbbbb`).getAttribute('href')
    ).toBe('/admin/users/bbbbbbbbbbbbbbbbbbbbbbbb');

    const strip = screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1');
    // 9 confirmed of 12 conclusive; insufficient evidence is left out.
    expect(screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1-precision').textContent).toBe('75%');
    expect(within(strip).getByText('of 12 conclusive')).toBeTruthy();
    expect(within(strip).getByText('15')).toBeTruthy();
    expect(within(strip).getByText('2 human, 1 automation')).toBeTruthy();
    expect(screen.getByTestId('shadow-detection-precision-note')).toBeTruthy();
  });

  it('reads the verdict and detector filters from the URL', () => {
    m.search = { detectionVerdict: 'all', detectionDetector: 'signupNetworkBurst' };
    renderTab();
    expect(m.useShadowDetections).toHaveBeenCalledWith({ detector: 'signupNetworkBurst', verdict: undefined });
  });

  it('shows an empty precision when no verdict is conclusive', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          summary: [summaryRow({ confirmedAbuse: 0, legitimateHuman: 0, legitimateAutomation: 0 })],
        })
      )
    );
    renderTab();
    expect(screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1-precision').textContent).toBe('-');
    expect(screen.getByText('No conclusive verdicts yet')).toBeTruthy();
  });

  it('shows the empty state for the unreviewed filter', () => {
    m.useShadowDetections.mockReturnValue(queryResult(list({ data: [], summary: [] })));
    renderTab();
    expect(screen.getByText('No unreviewed detections')).toBeTruthy();
  });

  it('shows the truncated notice', () => {
    m.useShadowDetections.mockReturnValue(queryResult(list({ truncated: true })));
    renderTab();
    expect(screen.getByTestId('shadow-detection-truncated')).toBeTruthy();
  });

  const openAndSubmit = async () => {
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
    fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse'));
    fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-confirm-btn'));
    return dialog;
  };

  it('submits the verdict against the revision it was decided on and closes', async () => {
    m.mutateAsync.mockResolvedValue({ status: 'recorded', item: detection({ verdict: 'confirmed_abuse' }) });
    await openAndSubmit();

    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({
        id: DETECTION_ID,
        expectedRevision: 4,
        verdict: 'confirmed_abuse',
        reason: 'Reviewed account activity',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('shadow-detection-verdict-dialog')).toBeNull());
  });

  it('keeps the dialog open with the latest detection when another admin graded it first', async () => {
    const graded = detection({
      verdict: 'legitimate_human',
      revision: 5,
      verdicts: [
        {
          verdict: 'legitimate_human',
          reason: 'Known customer or integration',
          reviewerId: 'dddddddddddddddddddddddd',
          reviewedAt: '2026-10-31T09:00:00.000Z',
        },
      ],
    });
    m.mutateAsync.mockResolvedValueOnce({ status: 'conflict', item: graded });
    await openAndSubmit();

    expect(await screen.findByTestId('shadow-detection-verdict-conflict')).toBeTruthy();
    const dialog = screen.getByTestId('shadow-detection-verdict-dialog');
    expect(within(dialog).getByText('Change verdict')).toBeTruthy();
    expect(
      within(screen.getByTestId('shadow-detection-history')).getByText('Known customer or integration')
    ).toBeTruthy();

    // Re-deciding sends the revision the admin now sees.
    m.mutateAsync.mockResolvedValueOnce({ status: 'recorded', item: graded });
    fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-confirm-btn'));
    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 5 }))
    );
  });
});

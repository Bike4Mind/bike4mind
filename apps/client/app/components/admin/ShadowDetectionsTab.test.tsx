import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ShadowDetectionSummaryRow } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  CampaignGroupRow,
  ShadowDetectionListResponse,
  ShadowDetectionRow,
} from '@client/app/hooks/data/shadowDetections';

// The data hooks are mocked so each path is driven directly.
const m = vi.hoisted(() => ({
  useShadowDetections: vi.fn(),
  mutateAsync: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  verdictError: null as Error | null,
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({
  useShadowDetections: m.useShadowDetections,
  useShadowDetectionVerdict: () => ({ mutateAsync: m.mutateAsync, isPending: false, error: m.verdictError }),
  useAbuseAssessments: () => ({ data: [], isPending: false, error: null }),
  useRequestAbuseAssessment: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { isAdmin: true } }) }));
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
  group: null,
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
    m.verdictError = null;
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

  it('shows the truncated notice and leaves the partial row count out of the header', () => {
    m.useShadowDetections.mockReturnValue(queryResult(list({ truncated: true })));
    renderTab();
    expect(screen.getByTestId('shadow-detection-truncated')).toBeTruthy();
    expect(within(screen.getByTestId('admin-page-header')).getByRole('heading').textContent).toBe('Detections');
  });

  it('counts the rows in the header when the list is complete', () => {
    renderTab();
    expect(within(screen.getByTestId('admin-page-header')).getByRole('heading').textContent).toBe('Detections (1)');
  });

  // The URL patch the last navigate wrote, applied to an empty search.
  const lastSearchPatch = (): Record<string, unknown> => {
    const { search } = m.navigate.mock.lastCall?.[0] as { search: (previous: object) => Record<string, unknown> };
    return search({});
  };

  it('lists every verdict once the Verdict chip is cleared, not the Unreviewed default', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-filter-clear-verdict-btn'));
    await waitFor(() => expect(m.navigate).toHaveBeenCalled());
    expect(lastSearchPatch()).toMatchObject({ detectionVerdict: 'all' });
  });

  it('clears the filters from a filtered empty state', async () => {
    m.search = { detectionDetector: 'signupNetworkBurst', detectionVerdict: 'confirmed_abuse' };
    m.useShadowDetections.mockReturnValue(queryResult(list({ data: [], summary: [] })));
    renderTab();
    expect(screen.getByText('No detections graded confirmed abuse')).toBeTruthy();

    const reset = screen.getByTestId('shadow-detection-reset-btn');
    expect(reset.textContent).toBe('Clear filters');
    fireEvent.click(reset);
    await waitFor(() => expect(m.navigate).toHaveBeenCalled());
    const patch = lastSearchPatch();
    expect(patch.detectionDetector).toBeUndefined();
    expect(patch.detectionVerdict).toBeUndefined();
  });

  it('refreshes from the unfiltered empty state', () => {
    const query = { ...queryResult(list({ data: [], summary: [] })) };
    m.useShadowDetections.mockReturnValue(query);
    renderTab();
    const reset = screen.getByTestId('shadow-detection-reset-btn');
    expect(reset.textContent).toBe('Refresh');
    fireEvent.click(reset);
    expect(query.refetch).toHaveBeenCalledTimes(1);
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('shows the load error with a retry', () => {
    const query = { ...queryResult(list()), data: undefined, error: new Error('boom') };
    m.useShadowDetections.mockReturnValue(query);
    renderTab();
    expect(within(screen.getByTestId('admin-error-state')).getByText("Couldn't load detections.")).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders a missing signal value as a muted dash', async () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [
            detection({ signals: [{ key: 'ipSignups', label: 'Signups from one IP', observed: null, threshold: 1 }] }),
          ],
        })
      )
    );
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const signals = await screen.findByTestId('shadow-detection-signals');
    expect(signals.textContent).toContain('Signups from one IP: - observed, threshold 1');
    expect(signals.textContent).not.toContain('n/a');
  });

  it('links every account the detection names in the verdict dialog', async () => {
    const userIds = ['b', 'c', 'd', 'e'].map(char => char.repeat(24));
    m.useShadowDetections.mockReturnValue(queryResult(list({ data: [detection({ userIds })] })));
    renderTab();
    const row = screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`);
    expect(within(row).getByText('+2 more')).toBeTruthy();

    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const actors = await screen.findByTestId('shadow-detection-dialog-actors');
    for (const userId of userIds) {
      expect(within(actors).getByTestId(`shadow-detection-dialog-user-link-${userId}`).getAttribute('href')).toBe(
        `/admin/users/${userId}`
      );
    }
    expect(within(actors).getByText('203.0.113.7 / Example Hosting / NL / Hosting')).toBeTruthy();
  });

  const [direct1, direct2, direct3, transitive] = ['b', 'c', 'd', 'e'].map(char => char.repeat(24));
  const campaignGroup = (): CampaignGroupRow => ({
    policyVersion: 1,
    window: { from: '2026-10-27T10:00:00.000Z', to: '2026-10-30T10:00:00.000Z' },
    firstObservedAt: '2026-10-29T10:00:00.000Z',
    lastObservedAt: '2026-10-30T10:00:00.000Z',
    members: [
      { userId: direct1, membership: 'direct', linkCount: 3, signedUpAt: '2026-10-29T09:00:00.000Z' },
      { userId: direct2, membership: 'direct', linkCount: 2, signedUpAt: '2026-10-29T09:01:00.000Z' },
      { userId: direct3, membership: 'direct', linkCount: 2, signedUpAt: '2026-10-29T09:02:00.000Z' },
      { userId: transitive, membership: 'transitive', linkCount: 1, signedUpAt: '2026-10-29T09:03:00.000Z' },
    ],
    links: [],
    evidence: [
      {
        relationship: 'fingerprint',
        axis: 'client',
        value: 't13d1516h2_8daaf6152771_02713d6af862',
        label: 'Client fingerprint t13d1516h2_8daaf6152771_02713d6af862',
        population: 3,
        userIds: [direct1, direct2, direct3],
      },
    ],
    ignored: [
      {
        relationship: 'mailDomain',
        value: 'gmail.com',
        population: 412,
        reason: 'personalMailProvider',
        memberCount: 4,
      },
    ],
    unknown: { fingerprint: 1, network: 0 },
    truncated: false,
    totals: { direct: 3, transitive: 1, links: 4 },
  });
  const openCampaignDialog = async (group: CampaignGroupRow) => {
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [
            detection({
              detector: 'accountCampaign',
              network: null,
              userIds: [direct1, direct2, direct3, transitive],
              group,
            }),
          ],
        })
      )
    );
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    return screen.findByTestId('shadow-detection-campaign-group');
  };

  it('shows how each campaign member is linked, and what was discounted, in the verdict dialog', async () => {
    const evidence = await openCampaignDialog(campaignGroup());

    expect(screen.getByTestId(`shadow-detection-campaign-membership-${transitive}`).textContent).toBe('Transitive');
    expect(screen.getByTestId(`shadow-detection-campaign-membership-${direct1}`).textContent).toBe('Direct');
    expect(within(evidence).getByTestId(`shadow-detection-dialog-user-link-${direct1}`).getAttribute('href')).toBe(
      `/admin/users/${direct1}`
    );
    expect(within(evidence).getByText(/3 direct, 1 transitive, 4 links/)).toBeTruthy();
    expect(
      within(screen.getByTestId('shadow-detection-campaign-evidence')).getByText(
        'Client fingerprint t13d1516h2_8daaf6152771_02713d6af862 (3 members; shared by 3 scanned accounts)'
      )
    ).toBeTruthy();
    expect(screen.getByTestId('shadow-detection-campaign-ignored').textContent).toContain(
      'gmail.com: personal mail provider (4 members; shared by 412 scanned accounts)'
    );
    expect(screen.getByTestId('shadow-detection-campaign-unknown').textContent).toBe(
      'Not captured, so neither for nor against a link: client fingerprint for 1 member.'
    );
    expect(screen.queryByTestId('shadow-detection-campaign-truncated')).toBeNull();
  });

  it('notes a truncated campaign group and hides empty ignored and unknown lists', async () => {
    await openCampaignDialog({
      ...campaignGroup(),
      ignored: [],
      unknown: { fingerprint: 0, network: 0 },
      truncated: true,
    });

    expect(screen.getByTestId('shadow-detection-campaign-truncated')).toBeTruthy();
    expect(screen.queryByTestId('shadow-detection-campaign-ignored')).toBeNull();
    expect(screen.queryByTestId('shadow-detection-campaign-unknown')).toBeNull();
  });

  it('shows a failed verdict as an error in the dialog', async () => {
    m.verdictError = new Error('Rate limit reached');
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
    expect(within(dialog).getByTestId('shadow-detection-verdict-error').textContent).toContain('Rate limit reached');
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
    m.mutateAsync.mockResolvedValueOnce({ status: 'conflict', item: graded, message: 'Graded by someone else.' });
    await openAndSubmit();

    expect((await screen.findByTestId('shadow-detection-verdict-conflict')).textContent).toContain(
      'Graded by someone else.'
    );
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

  it('falls back to a generic conflict message when the server sends none', async () => {
    m.mutateAsync.mockResolvedValueOnce({ status: 'conflict', item: detection({ revision: 5 }), message: null });
    await openAndSubmit();
    expect((await screen.findByTestId('shadow-detection-verdict-conflict')).textContent).toContain(
      'Another admin graded this detection first.'
    );
  });
});

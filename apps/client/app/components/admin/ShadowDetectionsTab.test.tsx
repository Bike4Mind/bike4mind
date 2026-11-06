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
  bulkMutateAsync: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  verdictError: null as Error | null,
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({
  useShadowDetections: m.useShadowDetections,
  useShadowDetectionVerdict: () => ({ mutateAsync: m.mutateAsync, isPending: false, error: m.verdictError }),
  useShadowDetectionBulkVerdict: () => ({ mutateAsync: m.bulkMutateAsync, isPending: false, error: null }),
  useAbuseAssessments: () => ({ data: [], isPending: false, error: null }),
  useRequestAbuseAssessment: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useVerdictEval: () => ({ data: undefined, isPending: true, error: null, refetch: vi.fn() }),
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

import ShadowDetectionsTab, { formatPaymentAmount } from './ShadowDetectionsTab';
import { DETECTIONS_INTRO_DISMISSED_KEY } from './shadowDetectionExplainer';

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
  payment: null,
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
  noAction: 0,
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
  accounts: [],
  burstPeers: [],
  reviewers: [],
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
    window.localStorage.clear();
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

  it('lists would-not-act records without counting them as unreviewed', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({ summary: [summaryRow({ recorded: 26, noAction: 6 })], data: [detection({ wouldAction: 'none' })] })
      )
    );
    renderTab();

    const strip = screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1');
    expect(within(strip).getByText('6 would not act')).toBeTruthy();
    // 26 recorded - 6 no-action - 15 graded.
    expect(within(strip).getByText('5 unreviewed')).toBeTruthy();
    expect(screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1-precision').textContent).toBe('75%');
    expect(within(screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`)).getByText('None')).toBeTruthy();
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
    expect(screen.getByTestId('shadow-detection-signal-context').textContent).toContain(
      'Signups from one IP: - (threshold 1)'
    );
    expect(signals.textContent).not.toContain('n/a');
  });

  it('opens the verdict dialog from a row click and labels the icon action', async () => {
    m.useShadowDetections.mockReturnValue(queryResult(list({ data: [detection()] })));
    renderTab();
    expect(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`).getAttribute('aria-label')).toBe(
      'Record verdict'
    );
    fireEvent.click(within(screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`)).getByText(detection().summary));
    expect(await screen.findByTestId('shadow-detection-signals')).toBeTruthy();
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

  it('links a payment-risk detection to its Stripe payment in the verdict dialog', async () => {
    const payment = {
      paymentIntentId: 'pi_123',
      chargeId: 'ch_123',
      kind: 'credits' as const,
      outcome: 'succeeded' as const,
      amount: 10000,
      currency: 'usd',
      riskLevel: 'elevated',
      livemode: false,
    };
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [detection({ detector: 'paymentRisk', wouldAction: 'contain', network: null, payment })],
          summary: [summaryRow({ detector: 'paymentRisk' })],
        })
      )
    );
    renderTab();
    const row = screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`);
    expect(within(row).getByText('Payment risk')).toBeTruthy();
    expect(within(row).getByTestId(`shadow-detection-stripe-link-${DETECTION_ID}`).getAttribute('href')).toBe(
      'https://dashboard.stripe.com/test/payments/pi_123'
    );

    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const evidence = await screen.findByTestId('shadow-detection-dialog-payment');
    expect(within(evidence).getByText('credits payment succeeded, 100.00 USD, Radar risk elevated')).toBeTruthy();
    expect(within(evidence).getByText('Stripe test mode')).toBeTruthy();
    expect(within(evidence).getByTestId('shadow-detection-dialog-stripe-link').getAttribute('href')).toBe(
      'https://dashboard.stripe.com/test/payments/pi_123'
    );
  });

  it('links a live-mode payment to the live Stripe Dashboard', () => {
    const payment = {
      paymentIntentId: 'pi_123',
      chargeId: 'ch_123',
      kind: 'credits' as const,
      outcome: 'succeeded' as const,
      amount: 10000,
      currency: 'usd',
      riskLevel: 'elevated',
      livemode: true,
    };
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [detection({ detector: 'paymentRisk', wouldAction: 'contain', network: null, payment })],
          summary: [summaryRow({ detector: 'paymentRisk' })],
        })
      )
    );
    renderTab();
    const row = screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`);
    expect(within(row).getByTestId(`shadow-detection-stripe-link-${DETECTION_ID}`).getAttribute('href')).toBe(
      'https://dashboard.stripe.com/payments/pi_123'
    );
  });

  it('formats a payment amount in the currency minor unit', () => {
    expect(formatPaymentAmount({ amount: 10000, currency: 'usd' })).toBe('100.00 USD');
    expect(formatPaymentAmount({ amount: 1500, currency: 'jpy' })).toBe('1500 JPY');
    expect(formatPaymentAmount({ amount: null, currency: 'usd' })).toBe('Unknown amount');
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
          source: 'reinstatement',
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
    expect(screen.getByTestId('shadow-detection-history-source').textContent).toBe(
      'Automatic: account reinstated by reviewer dddddddddddddddddddddddd'
    );

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

  describe('triage', () => {
    const ACTOR = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const PEER = 'cccccccccccccccccccccccc';
    const SPEND_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';
    const OTHER_ID = 'ffffffffffffffffffffffff';
    const burst = detection({ userIds: [ACTOR] });
    const spend = detection({
      id: SPEND_ID,
      detector: 'youngAccountSpend',
      userIds: [ACTOR],
      network: null,
      summary: 'Spent 900 credits in its first day',
      revision: 1,
    });
    const other = detection({ id: OTHER_ID, userIds: ['dddddddddddddddddddddddd'], revision: 2 });
    const triageList = () =>
      list({
        data: [burst, spend, other],
        accounts: [
          { userId: ACTOR, status: 'suspended', signupMethod: 'google', currentCredits: 0 },
          { userId: PEER, status: 'active', signupMethod: 'email', currentCredits: 1500 },
        ],
        burstPeers: [{ detectionId: DETECTION_ID, userIds: [PEER], truncated: false }],
      });

    beforeEach(() => {
      m.useShadowDetections.mockReturnValue(queryResult(triageList()));
    });

    const openDialog = async (id = DETECTION_ID) => {
      fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${id}`));
      return screen.findByTestId('shadow-detection-verdict-dialog');
    };

    it("shows each account's status, signup method and balance in the row and the dialog", async () => {
      renderTab();
      const account = `shadow-detection-account-${DETECTION_ID}-${ACTOR}`;
      expect(screen.getByTestId(`${account}-status`).textContent).toBe('Suspended');
      expect(screen.getByTestId(`${account}-facts`).textContent).toBe('google / 0 credits');

      const dialog = await openDialog();
      expect(within(dialog).getByTestId(`shadow-detection-dialog-account-${ACTOR}-status`).textContent).toBe(
        'Suspended'
      );
    });

    it("lists a burst's other signups in the row and the dialog", async () => {
      renderTab();
      const peers = screen.getByTestId(`shadow-detection-burst-peers-${DETECTION_ID}`);
      expect(peers.textContent).toContain('1 other account');
      expect(
        within(peers).getByTestId(`shadow-detection-burst-peer-link-${DETECTION_ID}-${PEER}`).getAttribute('href')
      ).toBe(`/admin/users/${PEER}`);

      const dialog = await openDialog();
      const dialogPeers = within(dialog).getByTestId('shadow-detection-dialog-burst-peers');
      expect(within(dialogPeers).getByTestId(`shadow-detection-dialog-account-${PEER}-facts`).textContent).toBe(
        'email / 1,500 credits'
      );
    });

    it("badges an account's open detections and grades them together by default", async () => {
      m.bulkMutateAsync.mockResolvedValue({ updated: [burst, spend], conflicts: [], notFound: [] });
      renderTab();
      expect(screen.getByTestId(`shadow-detection-related-${DETECTION_ID}`).textContent).toBe('2 open detections');
      expect(screen.queryByTestId(`shadow-detection-related-${OTHER_ID}`)).toBeNull();

      const dialog = await openDialog();
      expect(within(dialog).getByTestId('shadow-detection-apply-related-checkbox')).toBeChecked();
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input-preset-0'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-confirm-btn'));

      await waitFor(() =>
        expect(m.bulkMutateAsync).toHaveBeenCalledWith({
          items: [
            { id: DETECTION_ID, expectedRevision: 4 },
            { id: SPEND_ID, expectedRevision: 1 },
          ],
          verdict: 'confirmed_abuse',
          reason: 'Reviewed account activity',
        })
      );
      expect(m.mutateAsync).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('shadow-detection-verdict-dialog')).toBeNull());
    });

    it('grades only the open detection when the account box is cleared', async () => {
      m.mutateAsync.mockResolvedValue({ status: 'recorded', item: burst });
      renderTab();
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByTestId('shadow-detection-apply-related-checkbox'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-option-legitimate_human'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input-preset-0'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-confirm-btn'));

      await waitFor(() =>
        expect(m.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ id: DETECTION_ID, verdict: 'legitimate_human' })
        )
      );
      expect(m.bulkMutateAsync).not.toHaveBeenCalled();
    });

    it('picks a verdict with the number keys, but not while typing a note', async () => {
      renderTab();
      const dialog = await openDialog();

      fireEvent.keyDown(document.body, { key: '2' });
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-legitimate_human')).toBeChecked();

      const note = within(dialog).getByRole('textbox');
      fireEvent.keyDown(note, { key: '4' });
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-legitimate_human')).toBeChecked();

      fireEvent.keyDown(document.body, { key: '1' });
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse')).toBeChecked();
    });

    it('saves and opens the next unreviewed detection, keeping the reason', async () => {
      m.mutateAsync.mockResolvedValue({ status: 'recorded', item: other });
      renderTab();
      const dialog = await openDialog(OTHER_ID);
      fireEvent.keyDown(document.body, { key: '3' });
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input-preset-0'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-secondary-btn'));

      await waitFor(() =>
        expect(m.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ id: OTHER_ID, verdict: 'legitimate_automation' })
        )
      );
      // Wraps to the first unreviewed row; its verdict starts blank.
      const next = await screen.findByTestId('shadow-detection-verdict-dialog');
      await waitFor(() => expect(within(next).getByText(burst.summary)).toBeTruthy());
      expect(within(next).getByTestId('shadow-detection-verdict-option-legitimate_automation')).not.toBeChecked();
      expect(within(next).getByTestId('shadow-detection-verdict-dialog-hint').textContent).toContain('Pick a verdict');
    });

    it('records one verdict on the selected detections and reports the ones that moved', async () => {
      m.bulkMutateAsync.mockResolvedValue({
        updated: [other],
        conflicts: [{ ...spend, verdict: 'legitimate_human' }],
        notFound: [],
      });
      renderTab();
      fireEvent.click(within(screen.getByTestId(`admin-table-select-${SPEND_ID}`)).getByRole('checkbox'));
      fireEvent.click(within(screen.getByTestId(`admin-table-select-${OTHER_ID}`)).getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('shadow-detection-bulk-grade-btn'));

      const dialog = await screen.findByTestId('shadow-detection-bulk-verdict-dialog');
      expect(within(dialog).getByText('Record verdict on 2 detections')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: '1' });
      fireEvent.click(within(dialog).getByTestId('shadow-detection-bulk-verdict-dialog-reason-input-preset-1'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-bulk-verdict-dialog-confirm-btn'));

      await waitFor(() =>
        expect(m.bulkMutateAsync).toHaveBeenCalledWith({
          items: [
            { id: SPEND_ID, expectedRevision: 1 },
            { id: OTHER_ID, expectedRevision: 2 },
          ],
          verdict: 'confirmed_abuse',
          reason: 'Matches a known abuse pattern',
        })
      );
      expect((await screen.findByTestId('shadow-detection-bulk-notice')).textContent).toContain(
        '1 detection changed since this page loaded'
      );
      expect(screen.queryByTestId('shadow-detection-bulk-verdict-dialog')).toBeNull();
    });

    it("groups an account's detections together under its account line", () => {
      renderTab();
      fireEvent.click(screen.getByTestId('shadow-detection-group-toggle'));

      const group = screen.getByTestId(`admin-table-group-${ACTOR}`);
      expect(within(group).getByTestId(`shadow-detection-group-account-${ACTOR}-status`).textContent).toBe('Suspended');
      expect(within(group).getByText('2 detections')).toBeTruthy();
      const rowIds = screen.getAllByTestId(/^shadow-detection-row-/).map(row => row.dataset.testid);
      expect(rowIds).toEqual([
        `shadow-detection-row-${DETECTION_ID}`,
        `shadow-detection-row-${SPEND_ID}`,
        `shadow-detection-row-${OTHER_ID}`,
      ]);
    });
  });
});

describe('ShadowDetectionsTab explanations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    m.search = {};
    m.verdictError = null;
    m.useShadowDetections.mockReturnValue(queryResult(list()));
  });

  it('explains the page until dismissed, remembers that, and reopens on request', () => {
    const { unmount } = renderTab();
    expect(screen.getByTestId('shadow-detection-intro').textContent).toContain('shadow mode');

    fireEvent.click(screen.getByTestId('shadow-detection-intro-dismiss-btn'));
    expect(screen.queryByTestId('shadow-detection-intro')).toBeNull();
    expect(window.localStorage.getItem(DETECTIONS_INTRO_DISMISSED_KEY)).toBe('true');
    unmount();

    renderTab();
    expect(screen.queryByTestId('shadow-detection-intro')).toBeNull();
    fireEvent.click(screen.getByTestId('shadow-detection-intro-show-btn'));
    expect(screen.getByTestId('shadow-detection-intro')).toBeTruthy();
    expect(window.localStorage.getItem(DETECTIONS_INTRO_DISMISSED_KEY)).toBeNull();
  });

  it('defines the terms on the summary and the Would column', () => {
    renderTab();
    for (const term of ['policy', 'recorded', 'graded', 'precision', 'falsePositives', 'enforceBar', 'would']) {
      expect(screen.getAllByTestId(`shadow-detection-help-${term}`).length).toBeGreaterThan(0);
    }
  });

  it('shows conclusive verdicts toward the enforce bar', () => {
    renderTab();
    // 12 conclusive of the 50 needed.
    const bar = screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1-enforce-bar');
    expect(bar.textContent).toBe('12 / 50');
    expect(bar.getAttribute('data-status')).toBe('collecting');
    expect(screen.getByText('38 more conclusive to go')).toBeTruthy();
  });

  it('marks a detector that cleared the bar as ready', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(list({ summary: [summaryRow({ confirmedAbuse: 60, legitimateHuman: 1, legitimateAutomation: 0 })] }))
    );
    renderTab();
    const bar = screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1-enforce-bar');
    expect(bar.textContent).toBe('50 / 50');
    expect(bar.getAttribute('data-status')).toBe('ready');
  });

  it('guides each verdict and points to the user page for acting on abuse', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(list({ data: [detection({ userIds: ['bbbbbbbbbbbbbbbbbbbbbbbb'] })] }))
    );
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    expect(screen.getByTestId('shadow-detection-verdict-guide-insufficient_evidence').textContent).toContain(
      'two signups from one home IP'
    );
    expect(screen.getByTestId('shadow-detection-next-step-link').getAttribute('href')).toBe(
      '/admin/users/bbbbbbbbbbbbbbbbbbbbbbbb'
    );
  });

  it('sends a reviewer to each account page when the detection names several', () => {
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    expect(screen.getByTestId('shadow-detection-next-step').textContent).toContain(
      'Suspend each account from its user page'
    );
    expect(screen.queryByTestId('shadow-detection-next-step-link')).toBeNull();
  });
});

describe('ShadowDetectionsTab why explanations', () => {
  const REVIEWER_ID = 'dddddddddddddddddddddddd';
  const graded = (source: 'review' | 'suspension') =>
    detection({
      verdict: 'confirmed_abuse',
      verdicts: [
        {
          verdict: 'insufficient_evidence',
          reason: 'Earlier look',
          reviewerId: REVIEWER_ID,
          reviewedAt: '2026-10-30T12:00:00.000Z',
        },
        {
          verdict: 'confirmed_abuse',
          reason: 'Signup farm',
          reviewerId: REVIEWER_ID,
          reviewedAt: '2026-10-31T09:00:00.000Z',
          source,
        },
      ],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    m.search = {};
    m.verdictError = null;
  });

  it('names the signal that crossed its rule and keeps the rest as context', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [
            detection({
              signals: [
                { key: 'ipSignups', label: 'Self-serve signups from this IP', observed: 3, threshold: 2 },
                { key: 'asnSignups', label: 'Signups from this network', observed: 3, threshold: 10 },
                { key: 'hostingNetwork', label: 'Hosting network', observed: 1, threshold: null },
              ],
            }),
          ],
        })
      )
    );
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    expect(screen.getByTestId('shadow-detection-trigger-ipSignups').textContent).toBe(
      'Self-serve signups from this IP: 3 within 180 minutes (rule: more than 2)'
    );
    expect(screen.queryByTestId('shadow-detection-trigger-asnSignups')).toBeNull();
    const context = screen.getByTestId('shadow-detection-signal-context').textContent;
    expect(context).toContain('Signups from this network: 3 (threshold 10)');
    expect(context).toContain('Hosting network: 1');
  });

  it('falls back to the summary when no signal has a known rule', () => {
    m.useShadowDetections.mockReturnValue(queryResult(list()));
    renderTab();
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    expect(screen.getByTestId('shadow-detection-trigger').textContent).toContain(
      'Flagged: 3 signups from one IP in 180 minutes'
    );
  });

  it('attributes a manual verdict to its reviewer in the row, the dialog and the history', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(list({ data: [graded('review')], reviewers: [{ userId: REVIEWER_ID, name: 'Test Admin' }] }))
    );
    renderTab();
    expect(screen.getByTestId(`shadow-detection-verdict-by-${DETECTION_ID}`).textContent).toBe('By Test Admin');
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    const attribution = screen.getByTestId('shadow-detection-dialog-verdict-attribution').textContent;
    expect(attribution).toContain('By Test Admin on');
    expect(attribution).toContain('Signup farm');
    expect(screen.getAllByTestId('shadow-detection-history-source').map(node => node.textContent)).toEqual([
      'By Test Admin',
      'By Test Admin',
    ]);
  });

  it('marks a verdict recorded by a suspension as automatic', () => {
    m.useShadowDetections.mockReturnValue(
      queryResult(list({ data: [graded('suspension')], reviewers: [{ userId: REVIEWER_ID, name: null }] }))
    );
    renderTab();
    expect(screen.getByTestId(`shadow-detection-verdict-by-${DETECTION_ID}`).textContent).toBe('Automatic');
    fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
    expect(screen.getByTestId('shadow-detection-dialog-verdict-attribution').textContent).toContain(
      `Automatic: account suspended by reviewer ${REVIEWER_ID} on`
    );
  });

  it('shows no attribution on an unreviewed detection', () => {
    m.useShadowDetections.mockReturnValue(queryResult(list()));
    renderTab();
    expect(screen.queryByTestId(`shadow-detection-verdict-by-${DETECTION_ID}`)).toBeNull();
  });
});

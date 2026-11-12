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
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
  advisory: { data: undefined } as { data?: { advisories: Record<string, unknown>[] } },
  assessments: [] as Record<string, unknown>[],
}));
vi.mock('@client/app/hooks/data/aiAdvisory', () => ({ useAiAdvisory: () => m.advisory }));
vi.mock('@client/app/hooks/data/shadowDetections', () => ({
  useShadowDetections: m.useShadowDetections,
  useShadowDetectionVerdict: () => ({ mutateAsync: m.mutateAsync, isPending: false, error: m.verdictError }),
  useShadowDetectionBulkVerdict: () => ({ mutateAsync: m.bulkMutateAsync, isPending: false, error: null }),
  useAbuseAssessments: () => ({ data: m.assessments, isPending: false, error: null }),
  useRequestAbuseAssessment: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useVerdictEval: () => ({ data: undefined, isPending: true, error: null, refetch: vi.fn() }),
}));
vi.mock('./VerdictEvalSetsPanel', () => ({ VerdictEvalSetsPanel: () => null }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
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
vi.mock('./CampaignWatches/CampaignWatchesPanel', () => ({ CampaignWatchesPanel: () => null }));
vi.mock('./CampaignWatches/WatchAccountsButton', () => ({
  WatchAccountsButton: ({
    label,
    incomplete,
    incompleteHint,
  }: {
    label?: string;
    incomplete?: boolean;
    incompleteHint?: string;
  }) => (
    <span
      data-testid="watch-accounts-stub"
      data-label={label}
      data-incomplete={String(incomplete)}
      data-hint={incompleteHint}
    />
  ),
}));

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
  automated: 0,
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
    m.currentUser = { isAdmin: true };
    m.advisory = { data: undefined };
    m.assessments = [];
    m.useShadowDetections.mockReturnValue(queryResult(list()));
  });

  describe('AI advisory suggestion', () => {
    const advise = (detectionId = DETECTION_ID) => {
      m.advisory = {
        data: {
          advisories: [
            {
              userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
              detectionId,
              detector: 'signupNetworkBurst',
              abuseProbability: 0.9,
              assessedAt: '2026-10-30T11:00:00.000Z',
            },
          ],
        },
      };
    };
    const row = () => screen.getByTestId(`shadow-detection-row-${DETECTION_ID}`);

    it('shows a neutral chip on an unreviewed row the advisory flags', () => {
      advise();
      renderTab();
      expect(screen.getByTestId(`shadow-detection-ai-${DETECTION_ID}-chip`)).toHaveTextContent(
        '\u2726 Confirmed abuse, High'
      );
    });

    it('opens the dialog prefilled with the proposed verdict and reason on A', async () => {
      advise();
      m.mutateAsync.mockResolvedValue({ status: 'recorded', item: detection({ verdict: 'confirmed_abuse' }) });
      renderTab();
      fireEvent.keyDown(row(), { key: 'a' });
      const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse')).toBeChecked();
      expect(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input')).toHaveValue(
        'Accepted AI suggestion'
      );
      fireEvent.click(within(dialog).getByTestId('shadow-detection-verdict-dialog-confirm-btn'));
      await waitFor(() =>
        expect(m.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ verdict: 'confirmed_abuse', reason: 'Accepted AI suggestion' })
        )
      );
    });

    it('opens the dialog with nothing preselected on O', async () => {
      advise();
      renderTab();
      fireEvent.keyDown(row(), { key: 'o' });
      const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse')).not.toBeChecked();
      expect(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input')).toHaveValue('');
    });

    const assessed = () => {
      m.assessments = [
        {
          id: 'assessment-1',
          detectionId: DETECTION_ID,
          result: 'abuse',
          probabilities: [{ value: 'abuse', probability: 0.9 }],
          confidence: 0.9,
          model: 'example-model',
          modelVersion: null,
          policyVersion: 1,
          evidenceVersion: 1,
          featureSummary: {},
          failure: null,
          trigger: 'sweep',
          assessedAt: '2026-10-30T11:00:00.000Z',
        },
      ];
    };

    it('fills the verdict and the reason when the dialog suggestion is accepted', async () => {
      assessed();
      renderTab();
      fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
      const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
      const reason = within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input');
      expect(reason).toHaveValue('');
      fireEvent.click(within(dialog).getByTestId('shadow-detection-assessment-suggestion-accept-btn'));
      expect(within(dialog).getByTestId('shadow-detection-verdict-option-confirmed_abuse')).toBeChecked();
      expect(within(dialog).getByTestId('shadow-detection-verdict-dialog-reason-input')).toHaveValue(
        'Accepted AI suggestion'
      );
    });

    it('opens the why-wrong picker in the dialog on O', async () => {
      advise();
      assessed();
      renderTab();
      fireEvent.keyDown(row(), { key: 'o' });
      const dialog = await screen.findByTestId('shadow-detection-verdict-dialog');
      expect(within(dialog).getByTestId('shadow-detection-assessment-suggestion-why-0')).toBeTruthy();
      expect(within(dialog).queryByTestId('shadow-detection-assessment-suggestion-override-btn')).toBeNull();
    });

    it('shows no chip and leaves A inert when the advisory is unavailable', () => {
      renderTab();
      expect(screen.queryByTestId(`shadow-detection-ai-${DETECTION_ID}`)).toBeNull();
      fireEvent.keyDown(row(), { key: 'a' });
      expect(screen.queryByTestId('shadow-detection-verdict-dialog')).toBeNull();
    });

    it('shows no chip on a reviewed row', () => {
      advise();
      m.useShadowDetections.mockReturnValue(queryResult(list({ data: [detection({ verdict: 'confirmed_abuse' })] })));
      renderTab();
      expect(screen.queryByTestId(`shadow-detection-ai-${DETECTION_ID}`)).toBeNull();
    });

    it('keeps A inert for a support reader', () => {
      advise();
      m.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
      renderTab();
      expect(screen.getByTestId(`shadow-detection-ai-${DETECTION_ID}-chip`)).toBeTruthy();
      fireEvent.keyDown(row(), { key: 'a' });
      expect(screen.queryByTestId('shadow-detection-verdict-dialog')).toBeNull();
    });
  });

  it('leaves the outer padding to the admin page frame', () => {
    renderTab();
    const root = screen.getByTestId('admin-shadow-detections-tab');
    const style = getComputedStyle(root);
    for (const side of [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]) {
      expect(parseFloat(side || '0')).toBe(0);
    }
  });

  it('defaults to unreviewed detections and renders rows and stats', () => {
    renderTab();

    expect(screen.getByTestId('detections-start-here')).toHaveTextContent('Open Review evidence');
    expect(screen.getByTestId('detections-start-here')).toHaveTextContent('does not change account access');
    expect(screen.getByText('Suggested response')).toBeInTheDocument();

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

  it('disables grading for a support reader', () => {
    m.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
    m.useShadowDetections.mockReturnValue(queryResult(list({ data: [detection()] })));
    renderTab();
    expect(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`)).toBeDisabled();
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

  it('offers a Watch button only on account-campaign rows, flagged incomplete when the group is truncated', () => {
    renderTab();
    expect(screen.queryByTestId('watch-accounts-stub')).toBeNull();

    m.useShadowDetections.mockReturnValue(
      queryResult(list({ data: [detection({ detector: 'accountCampaign', network: null, group: campaignGroup() })] }))
    );
    const { unmount } = renderTab();
    expect(screen.getByTestId('watch-accounts-stub')).toHaveAttribute('data-label', 'Watch');
    expect(screen.getByTestId('watch-accounts-stub')).toHaveAttribute('data-incomplete', 'false');
    unmount();

    m.useShadowDetections.mockReturnValue(
      queryResult(
        list({
          data: [
            detection({
              detector: 'accountCampaign',
              network: null,
              group: { ...campaignGroup(), truncated: true },
            }),
          ],
        })
      )
    );
    renderTab();
    expect(screen.getByTestId('watch-accounts-stub')).toHaveAttribute('data-incomplete', 'true');
    expect(screen.getByTestId('watch-accounts-stub')).toHaveAttribute(
      'data-hint',
      'This group was cut to its stored cap, so it cannot be saved as a watch.'
    );
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
    expect(within(dialog).getByText('View review')).toBeTruthy();
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

  describe('bulk verdicts', () => {
    const selectRow = (id: string) =>
      fireEvent.click(within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox'));
    const OTHER_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';
    const twoRows = () =>
      m.useShadowDetections.mockReturnValue(
        queryResult(list({ data: [detection(), detection({ id: OTHER_ID, revision: 1 })] }))
      );

    const submitBulk = async () => {
      fireEvent.click(screen.getByTestId('shadow-detection-bulk-grade-btn'));
      const dialog = await screen.findByTestId('shadow-detection-bulk-verdict-dialog');
      fireEvent.click(within(dialog).getByTestId('shadow-detection-bulk-verdict-option-insufficient_evidence'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-bulk-verdict-dialog-reason-input-preset-0'));
      fireEvent.click(within(dialog).getByTestId('shadow-detection-bulk-verdict-dialog-confirm-btn'));
    };

    it('grades the selected rows at the revisions they were selected at, then reports the outcome', async () => {
      twoRows();
      m.bulkMutateAsync.mockResolvedValue({ graded: [detection()], conflicts: [], missing: [], failed: [] });
      renderTab();
      selectRow(OTHER_ID);

      await submitBulk();

      await waitFor(() =>
        expect(m.bulkMutateAsync).toHaveBeenCalledWith({
          items: [{ id: OTHER_ID, expectedRevision: 1 }],
          verdict: 'insufficient_evidence',
          reason: 'Reviewed account activity',
        })
      );
      expect((await screen.findByTestId('shadow-detection-bulk-outcome')).textContent).toContain('Graded 1 detection.');
      expect(screen.queryByTestId('shadow-detection-bulk-verdict-dialog')).toBeNull();
      expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
    });

    it('grades every row matching the filter, and says which changed meanwhile', async () => {
      twoRows();
      m.bulkMutateAsync.mockResolvedValue({
        graded: [detection()],
        conflicts: [detection({ id: OTHER_ID, verdict: 'confirmed_abuse' })],
        missing: [],
        failed: [],
      });
      renderTab();
      selectRow(DETECTION_ID);
      fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));

      await submitBulk();

      await waitFor(() =>
        expect(m.bulkMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            items: [
              { id: DETECTION_ID, expectedRevision: 4 },
              { id: OTHER_ID, expectedRevision: 1 },
            ],
          })
        )
      );
      expect((await screen.findByTestId('shadow-detection-bulk-outcome')).textContent).toContain(
        '1 detection changed since you selected them'
      );
    });

    it('words select-all as the loaded rows when the list is truncated', () => {
      m.useShadowDetections.mockReturnValue(
        queryResult(list({ truncated: true, data: [detection(), detection({ id: OTHER_ID, revision: 1 })] }))
      );
      renderTab();
      selectRow(DETECTION_ID);
      expect(screen.getByTestId('admin-select-all-matching-btn').textContent).toBe('Select all 2 loaded');
    });

    it('blocks a selection over the request cap', async () => {
      const many = Array.from({ length: 201 }, (_, index) => detection({ id: index.toString(16).padStart(24, '0') }));
      m.useShadowDetections.mockReturnValue(queryResult(list({ data: many })));
      renderTab();
      selectRow(many[0]!.id);
      fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
      fireEvent.click(screen.getByTestId('shadow-detection-bulk-grade-btn'));
      const dialog = await screen.findByTestId('shadow-detection-bulk-verdict-dialog');

      expect(within(dialog).getByText(/Grade at most 200 detections at once/)).toBeTruthy();
      expect(m.bulkMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('automation verdicts', () => {
    const automated = detection({
      verdict: 'insufficient_evidence',
      verdicts: [
        {
          verdict: 'insufficient_evidence',
          reason: 'No suspension, reinstatement, other detector or conclusive assessment within 7 days',
          reviewerId: 'automation',
          reviewedAt: '2026-11-08T09:00:00.000Z',
          source: 'automation',
        },
      ],
    });

    it('labels an automation verdict as such in the row and the history', async () => {
      m.useShadowDetections.mockReturnValue(queryResult(list({ data: [automated] })));
      renderTab();

      expect(screen.getByTestId(`shadow-detection-verdict-${DETECTION_ID}`).textContent).toBe(
        'Insufficient evidence (automation)'
      );
      fireEvent.click(screen.getByTestId(`shadow-detection-grade-btn-${DETECTION_ID}`));
      const history = await screen.findByTestId('shadow-detection-history');
      expect(within(history).getByText('Graded by automation')).toBeTruthy();
      expect(within(history).queryByText(/Reviewer automation/)).toBeNull();
    });

    it('counts automation verdicts apart from admin verdicts in the summary', () => {
      m.useShadowDetections.mockReturnValue(
        queryResult(list({ summary: [summaryRow({ recorded: 20, automated: 4 })] }))
      );
      renderTab();
      const strip = screen.getByTestId('shadow-detection-summary-signupNetworkBurst-v1');
      expect(within(strip).getByTestId('shadow-detection-summary-signupNetworkBurst-v1-automated').textContent).toBe(
        '4'
      );
      // 20 recorded - 15 admin-graded - 4 automation.
      expect(within(strip).getByText('1 unreviewed')).toBeTruthy();
    });

    it('reads the automation filter from the URL', () => {
      m.search = { detectionVerdict: 'automated' };
      renderTab();
      expect(m.useShadowDetections).toHaveBeenCalledWith({ detector: undefined, verdict: 'automated' });
    });
  });
});

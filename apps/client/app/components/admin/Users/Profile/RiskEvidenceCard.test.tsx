import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminRiskEvidenceView } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ useAdminRiskEvidence: vi.fn() }));
vi.mock('@client/app/hooks/data/adminRiskEvidence', () => ({ useAdminRiskEvidence: mocks.useAdminRiskEvidence }));

import { RiskEvidenceCard } from './RiskEvidenceCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <RiskEvidenceCard userId="u1" />
    </CssVarsProvider>
  );

const at = new Date('2026-10-20T09:00:00.000Z');
const missing = { status: 'missing', provenance: 'auth_events', reason: 'no_activity' } as const;

const buildView = (overrides: Partial<AdminRiskEvidenceView> = {}): AdminRiskEvidenceView => ({
  riskScore: { score: 40, signals: [], computedAt: at, reviewState: 'pending' },
  refresh: null,
  evidenceUnreadable: false,
  evidence: {
    version: 1,
    computedAt: at,
    window: { from: new Date('2026-09-20T09:00:00.000Z'), to: at },
    trigger: 'login',
    facts: {
      signupNetwork: {
        status: 'observed',
        provenance: 'signup_request',
        value: { isDatacenter: true, asnKnown: false, challengeVerified: true },
        sampleCount: 1,
        latestAt: null,
        truncated: false,
      },
      edgeFingerprint: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
      wafSignals: missing,
      authActivity: {
        status: 'observed',
        provenance: 'auth_events',
        value: { logins: 3, signups: 1, distinctIps: 2, distinctNetworks: 1 },
        sampleCount: 200,
        latestAt: at,
        truncated: true,
      },
      apiKeys: { status: 'failed', provenance: 'api_key_records', error: 'read timed out' },
      usage: missing,
      concurrency: missing,
      sensitiveActions: missing,
    },
  },
  ...overrides,
});

const mockView = (data: AdminRiskEvidenceView | undefined, state = {}) =>
  mocks.useAdminRiskEvidence.mockReturnValue({ data, isLoading: false, isError: false, ...state });

beforeEach(() => vi.clearAllMocks());

describe('RiskEvidenceCard', () => {
  it('renders observed, missing and failed facts', () => {
    mockView(buildView());
    renderCard();

    const network = screen.getByTestId('risk-evidence-fact-signupNetwork');
    expect(within(network).getByText('Observed')).toBeInTheDocument();
    expect(within(network).getByText('is datacenter: Yes')).toBeInTheDocument();
    expect(within(network).getByText('point sample')).toBeInTheDocument();

    const auth = screen.getByTestId('risk-evidence-fact-authActivity');
    expect(within(auth).getByText('200 samples (capped)')).toBeInTheDocument();

    const fingerprint = screen.getByTestId('risk-evidence-fact-edgeFingerprint');
    expect(within(fingerprint).getByText('Unknown')).toBeInTheDocument();
    expect(within(fingerprint).getByText('Not captured')).toBeInTheDocument();

    const keys = screen.getByTestId('risk-evidence-fact-apiKeys');
    expect(within(keys).getByText('Failed')).toBeInTheDocument();
    expect(within(keys).getByText('read timed out')).toBeInTheDocument();
    expect(screen.getByTestId('risk-evidence-score')).toHaveTextContent('Signup score 40 (pending)');
    expect(screen.queryByTestId('risk-evidence-failure-alert')).not.toBeInTheDocument();
  });

  it('shows the last refresh failure', () => {
    mockView(
      buildView({ refresh: { pendingSince: null, lastTrigger: 'login', lastFailureAt: at, lastFailure: 'db down' } })
    );
    renderCard();
    expect(screen.getByTestId('risk-evidence-failure-alert')).toHaveTextContent('db down');
  });

  it('shows the empty state but keeps the score when no evidence exists', () => {
    mockView(buildView({ evidence: null }));
    renderCard();
    expect(screen.getByTestId('risk-evidence-empty')).toHaveTextContent('No evidence collected yet');
    expect(screen.getByTestId('risk-evidence-score')).toBeInTheDocument();
    expect(screen.queryByTestId('risk-evidence-table')).not.toBeInTheDocument();
  });

  it('shows an error state and retries through the hook refetch', () => {
    const refetch = vi.fn();
    mockView(undefined, { isError: true, refetch });
    renderCard();
    expect(screen.getByTestId('risk-evidence-error')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('explains stored evidence from another version instead of claiming none was collected', () => {
    mockView(buildView({ evidence: null, evidenceUnreadable: true }));
    renderCard();
    expect(screen.getByTestId('risk-evidence-empty')).toHaveTextContent('Stored evidence is from another version');
  });

  it('formats credits spent with separators and rounds minutes to first key to one decimal', () => {
    const view = buildView();
    mockView({
      ...view,
      evidence: view.evidence && {
        ...view.evidence,
        facts: {
          ...view.evidence.facts,
          usage: {
            status: 'observed',
            provenance: 'usage_ledger',
            value: { events: 4, completed: 3, failed: 1, creditsSpent: 12345.4 },
            sampleCount: 4,
            latestAt: at,
            truncated: false,
          },
          apiKeys: {
            status: 'observed',
            provenance: 'api_key_records',
            value: { created: 1, minutesToFirstKey: 12.3456 },
            sampleCount: 1,
            latestAt: at,
            truncated: false,
          },
        },
      },
    });
    renderCard();

    expect(
      within(screen.getByTestId('risk-evidence-fact-usage')).getByText('credits spent: 12,345 credits')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('risk-evidence-fact-apiKeys')).getByText('minutes to first key: 12.3')
    ).toBeInTheDocument();
  });
});

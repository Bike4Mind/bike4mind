import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SignupTimeseries } from '@client/app/utils/signupSignals';
import type { IncidentRange, IncidentSignals, IncidentState } from './incidentTypes';

const mocks = vi.hoisted(() => ({
  signals: vi.fn(),
  state: vi.fn(),
  timeseries: vi.fn(),
  refetchSignals: vi.fn(),
  refetchState: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/data/admin', () => ({
  useSecurityIncidentSignals: mocks.signals,
  useSecurityIncidentState: mocks.state,
  useSignupAnomaly: () => ({ data: undefined }),
}));
vi.mock('../Signups/useSignupTimeseries', () => ({ useSignupTimeseries: mocks.timeseries }));
vi.mock('../Signups/SignupChart', () => ({ SignupChart: () => <div data-testid="signup-chart-stub" /> }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { IncidentView } from './IncidentView';

const DASH = '\u2014';
const theme = extendTheme({ ...getThemeConfig() });
const renderView = () =>
  render(
    <CssVarsProvider theme={theme}>
      <IncidentView />
    </CssVarsProvider>
  );

const signalsData = (overrides: Partial<IncidentSignals> = {}): IncidentSignals => ({
  generatedAt: '2026-11-02T12:00:00.000Z',
  range: '24h',
  metrics: {
    successfulSignups: 1234,
    fullGrants: 56,
    signupCodeSends: 900,
    apiKeyCreations: 12,
    oauthSignupsRefused: 3,
    youngAccountSpendUsd: 1500,
    turnstileMisconfigured: 0,
  },
  waf: { allowed: 9000, blocked: 320, counted: 80 },
  alarms: { total: 20, inAlarm: [{ name: 'signup-rate', since: '2026-11-02T11:30:00.000Z' }] },
  blockLists: {
    lists: [
      { name: 'Hosting networks', entries: 10, action: 'block' },
      { name: 'Watch list', entries: 1, action: 'count' },
    ],
    blockerActiveEntries: { value: 4, at: '2026-11-02T11:55:00.000Z' },
  },
  ...overrides,
});

const stateData = (overrides: Partial<IncidentState> = {}): IncidentState => ({
  generatedAt: '2026-11-02T12:00:00.000Z',
  defenses: {
    turnstile: { enabled: true, failClosed: true, secretConfigured: true },
    grantBudget: { limit: 50000, spentToday: 12500, day: '2026-11-02' },
    newAccountSpendCapDays: 7,
    paymentRisk: {
      alertsEnabled: true,
      autoRefundEnabled: false,
      linkedAccountActions: true,
      checkoutMaxBlockedAttempts: 3,
    },
  },
  queues: { riskReviewsPending: 5, heldGrants: 0, domainHoldsPending: 2 },
  payments: {
    last24h: {
      attempts: 42,
      succeeded: 30,
      failed: 12,
      radarBlocked: 4,
      elevatedRisk: 6,
      hostingNetwork: 2,
      distinctCards: 25,
    },
    last7d: null,
    error: 'Weekly totals timed out.',
  },
  ...overrides,
});

const query = <T,>(data: T | undefined, extra: Record<string, unknown> = {}) => ({
  data,
  isError: false,
  isFetching: false,
  ...extra,
});

const timeseries = { totals: { total: 10, likelyLegit: 8, suspected: 2 } } as unknown as SignupTimeseries;

describe('IncidentView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeAdminRouter.reset({ tab: 'security-dashboard' });
    mocks.signals.mockReturnValue(query(signalsData(), { refetch: mocks.refetchSignals }));
    mocks.state.mockReturnValue(query(stateData(), { refetch: mocks.refetchState }));
    mocks.timeseries.mockReturnValue(query(timeseries));
  });

  it('renders the five tile values and the defense chips', () => {
    renderView();
    expect(screen.getByTestId('security-incident-signups-value')).toHaveTextContent('1,234');
    expect(screen.getByText('Full grants 56')).toBeInTheDocument();
    expect(screen.getByTestId('security-incident-spend-value')).toHaveTextContent('$1,500.00');
    expect(screen.getByTestId('security-incident-waf-value')).toHaveTextContent('320');
    expect(screen.getByText('of 9,400 requests')).toBeInTheDocument();
    expect(screen.getByTestId('security-incident-alarms-value')).toHaveTextContent('1');
    expect(screen.getByText('of 20 alarms')).toBeInTheDocument();
    expect(screen.getByTestId('security-incident-payments-value')).toHaveTextContent('42');
    expect(screen.getByText('4 Radar blocked, 6 elevated risk')).toBeInTheDocument();

    expect(screen.getByTestId('security-incident-turnstile-chip')).toHaveTextContent('On, fail closed');
    expect(screen.getByTestId('security-incident-turnstile-chip')).toHaveAttribute('data-tone', 'good');
    expect(screen.queryByTestId('security-incident-turnstile-secret-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('security-incident-block-list-0-chip')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('security-incident-block-list-1-chip')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('security-incident-grant-budget')).toHaveTextContent('12,500 of 50,000 credits');
    expect(screen.getByTestId('security-incident-spend-cap')).toHaveTextContent('7 days');
    expect(screen.getByTestId('security-incident-payment-auto-refund-chip')).toHaveTextContent('Auto-refund off');
    expect(screen.getByTestId('security-incident-payment-auto-refund-chip')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('security-incident-payment-risk')).toHaveTextContent('Checkout block after 3 attempts');
    expect(screen.getAllByTestId('security-incident-alarm-row')[0]).toHaveTextContent('signup-rate');
    expect(screen.getByTestId('security-incident-payments-24h-distinctCards')).toHaveTextContent('25');
    expect(screen.getByTestId('security-incident-payments-7d-distinctCards')).toHaveTextContent(DASH);
    expect(screen.getByTestId('security-incident-payments-error')).toHaveTextContent('Weekly totals timed out.');
    expect(screen.getByTestId('security-incident-signal-api-key-creations')).toHaveTextContent('12');
    expect(screen.getByTestId('security-incident-as-of')).toBeInTheDocument();
  });

  it('renders a dash and the section error for every section that failed, never a red zero', () => {
    mocks.signals.mockReturnValue(
      query(
        signalsData({
          metrics: {
            successfulSignups: null,
            fullGrants: null,
            signupCodeSends: null,
            apiKeyCreations: null,
            oauthSignupsRefused: null,
            youngAccountSpendUsd: null,
            turnstileMisconfigured: null,
            error: 'Metrics unavailable.',
          },
          waf: { allowed: null, blocked: null, counted: null, error: 'Firewall metrics unavailable.' },
          alarms: { total: null, inAlarm: [], error: 'Alarms unavailable.' },
          blockLists: { lists: [], blockerActiveEntries: null, error: 'Block lists unavailable.' },
        }),
        { refetch: mocks.refetchSignals }
      )
    );
    mocks.state.mockReturnValue(
      query(
        stateData({
          defenses: {
            turnstile: null,
            grantBudget: null,
            newAccountSpendCapDays: null,
            paymentRisk: null,
            error: 'Settings unavailable.',
          },
          queues: {
            riskReviewsPending: null,
            heldGrants: null,
            domainHoldsPending: null,
            error: 'Queues unavailable.',
          },
          payments: { last24h: null, last7d: null, error: 'Payments unavailable.' },
        }),
        { refetch: mocks.refetchState }
      )
    );
    renderView();

    for (const id of ['signups', 'spend', 'waf', 'alarms', 'payments']) {
      expect(screen.getByTestId(`security-incident-${id}-value`)).toHaveTextContent(DASH);
    }
    expect(screen.getAllByText('Metrics unavailable.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Firewall metrics unavailable.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Payments unavailable.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Queues unavailable.')).toHaveLength(3);
    expect(screen.getByTestId('security-incident-grant-budget')).toHaveTextContent('Settings unavailable.');
    expect(screen.getByTestId('security-incident-block-lists')).toHaveTextContent('Block lists unavailable.');
    expect(within(screen.getByTestId('security-incident-alarms-card')).getByRole('alert')).toHaveTextContent(
      'Alarms unavailable.'
    );
    expect(screen.queryByTestId('security-incident-turnstile-chip')).not.toBeInTheDocument();
  });

  it('shows a neutral line when no alarm is firing', () => {
    mocks.signals.mockReturnValue(query(signalsData({ alarms: { total: 20, inAlarm: [] } })));
    renderView();
    expect(screen.getByTestId('security-incident-alarms-empty')).toHaveTextContent('No alarms firing');
    expect(screen.getByTestId('security-incident-alarms-value')).toHaveTextContent('0');
    expect(screen.queryByTestId('security-incident-alarm-row')).not.toBeInTheDocument();
  });

  it.each([
    ['risk-review', 'signup-risk-review'],
    ['held-grants', 'held-signup-grants'],
    ['domain-holds', 'signup-domain-holds'],
  ])('opens the %s queue on its own admin tab', (queue, slug) => {
    renderView();
    fireEvent.click(screen.getByTestId(`security-incident-queue-${queue}-btn`));
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/admin', search: { tab: slug } })
    );
    expect(fakeAdminRouter.search).toEqual({ tab: slug });
  });

  it('passes the selected range to the signals hook and maps 1h onto the daily signup chart', () => {
    renderView();
    const lastRange = () => mocks.signals.mock.calls.at(-1)?.[0] as IncidentRange;
    expect(lastRange()).toBe('24h');

    fireEvent.click(screen.getByTestId('security-incident-range-1h'));
    expect(lastRange()).toBe('1h');
    expect(mocks.timeseries).toHaveBeenLastCalledWith('24h');

    fireEvent.click(screen.getByTestId('security-incident-range-7d'));
    expect(lastRange()).toBe('7d');
    expect(mocks.timeseries).toHaveBeenLastCalledWith('7d');
    expect(mocks.state.mock.calls.every(call => call[0] === true)).toBe(true);
  });

  it('flags an enabled Turnstile without its secret', () => {
    mocks.state.mockReturnValue(
      query(
        stateData({
          defenses: {
            ...stateData().defenses,
            turnstile: { enabled: true, failClosed: false, secretConfigured: false },
          },
        })
      )
    );
    renderView();
    expect(screen.getByTestId('security-incident-turnstile-chip')).toHaveTextContent('On');
    expect(screen.getByTestId('security-incident-turnstile-chip')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByTestId('security-incident-turnstile-secret-chip')).toHaveTextContent('Secret missing');
    expect(screen.getByTestId('security-incident-turnstile-secret-chip')).toHaveAttribute('data-tone', 'warn');
  });

  it('keeps the other half of the page when one hook fails, with a retry', () => {
    mocks.signals.mockReturnValue(query(undefined, { isError: true, refetch: mocks.refetchSignals }));
    renderView();
    expect(screen.getByTestId('security-incident-signups-value')).toHaveTextContent(DASH);
    expect(screen.getByTestId('security-incident-payments-value')).toHaveTextContent('42');
    expect(screen.getByTestId('security-incident-queue-risk-review-count')).toHaveTextContent('5');
    fireEvent.click(within(screen.getByTestId('security-incident-alarms-card')).getByTestId('admin-error-retry-btn'));
    expect(mocks.refetchSignals).toHaveBeenCalledOnce();
  });

  it('shows skeletons while loading', () => {
    mocks.signals.mockReturnValue(query(undefined));
    mocks.state.mockReturnValue(query(undefined));
    mocks.timeseries.mockReturnValue(query(undefined));
    renderView();
    expect(screen.getAllByTestId('security-incident-tile-skeleton')).toHaveLength(5);
    expect(screen.getByTestId('security-incident-queues-card-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('security-incident-signup-chart-skeleton')).toBeInTheDocument();
  });
});

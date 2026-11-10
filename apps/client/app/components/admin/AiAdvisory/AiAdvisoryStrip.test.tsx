import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TAB_PARAM, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AiAdvisorySummaryResponse } from '@client/app/hooks/data/aiAdvisory';
import { AiAdvisoryStrip } from './AiAdvisoryStrip';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  data: undefined as AiAdvisorySummaryResponse | undefined,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/hooks/data/aiAdvisory', () => ({ useAiAdvisory: () => ({ data: mocks.data }) }));
vi.mock('../CampaignWatches/WatchAccountsButton', () => ({
  WatchAccountsButton: ({ incomplete }: { incomplete?: boolean }) => (
    <span data-testid="watch-accounts-stub" data-incomplete={String(incomplete)} />
  ),
}));
vi.mock('../BlockedIPs/IpBlockDialogs', () => ({
  BlockIpDialog: ({ initialIp }: { initialIp: string }) => <div data-testid="block-ip-dialog">{initialIp}</div>,
}));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const advisory = (userId: string, detector: 'accountCampaign' | 'signupNetworkBurst') => ({
  userId,
  detectionId: 'd'.repeat(24),
  detector,
  abuseProbability: 0.9,
  assessedAt: '2026-11-05T11:00:00.000Z',
});

const summary = (overrides: Partial<AiAdvisorySummaryResponse> = {}): AiAdvisorySummaryResponse => ({
  since: '2026-11-04T12:00:00.000Z',
  advisories: [],
  networks: [],
  mailDomains: [],
  linkedAccounts: [],
  linkedAccountsStatus: 'complete',
  truncated: false,
  ...overrides,
});

describe('AiAdvisoryStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.data = undefined;
  });

  it('renders nothing while loading or when nothing is flagged', () => {
    const { container, rerender } = render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(container).toBeEmptyDOMElement();
    mocks.data = summary();
    rerender(<AiAdvisoryStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the flagged accounts, names the top signal and links Review to the filtered Users list', () => {
    mocks.data = summary({
      advisories: [
        advisory('1'.repeat(24), 'accountCampaign'),
        advisory('2'.repeat(24), 'accountCampaign'),
        advisory('3'.repeat(24), 'signupNetworkBurst'),
      ],
    });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.getByTestId('admin-dashboard-ai-advisory-summary')).toHaveTextContent(
      '3 accounts likely abuse (last 24h, unreviewed) \u00b7 top signal: Account campaign'
    );
    fireEvent.click(screen.getByTestId('admin-dashboard-ai-advisory-review-btn'));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: expect.objectContaining({ [ADMIN_TAB_PARAM]: ADMIN_USERS_TAB_SLUG, aiVerdict: 'abuse' }),
    });
  });

  it.each([true, false])('passes truncated=%s to the watch button as incomplete', truncated => {
    mocks.data = summary({ advisories: [advisory('1'.repeat(24), 'accountCampaign')], truncated });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.getByTestId('watch-accounts-stub')).toHaveAttribute('data-incomplete', String(truncated));
  });

  it('offers to block a shared IP and to open a shared domain, acting on neither by itself', () => {
    mocks.data = summary({
      advisories: [advisory('1'.repeat(24), 'accountCampaign')],
      networks: [
        { ip: '10.0.0.1', country: 'EG', asnOrg: 'Org', hosting: false, accountCount: 2, detectorWouldBlock: false },
      ],
      mailDomains: [{ domain: 'example.test', accountCount: 2 }],
    });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.queryByTestId('block-ip-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-dashboard-ai-advisory-ip-10.0.0.1'));
    expect(screen.getByTestId('block-ip-dialog')).toHaveTextContent('10.0.0.1');

    fireEvent.click(screen.getByTestId('admin-dashboard-ai-advisory-domain-example.test'));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: expect.objectContaining({ [ADMIN_TAB_PARAM]: ADMIN_USERS_TAB_SLUG, domain: 'example.test' }),
    });
  });

  it('marks a capped count', () => {
    mocks.data = summary({ advisories: [advisory('1'.repeat(24), 'accountCampaign')], truncated: true });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.getByTestId('admin-dashboard-ai-advisory-summary')).toHaveTextContent('1+ account likely abuse');
  });

  it('shows exact-IP candidates separately with provenance links and no inherited probability', () => {
    mocks.data = summary({
      advisories: [advisory('1'.repeat(24), 'accountCampaign')],
      linkedAccounts: [
        {
          userId: '2'.repeat(24),
          name: 'Example candidate',
          links: [{ sourceUserId: '1'.repeat(24), ip: '198.51.100.10', sourceKind: 'signup', candidateKind: 'login' }],
        },
      ],
    });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    const section = screen.getByTestId('ai-advisory-linked-accounts');
    expect(section).toHaveTextContent('1 linked account to review - not AI abuse verdicts');
    expect(section).toHaveTextContent('login IP 198.51.100.10');
    expect(section).toHaveTextContent('No name-only or JA4-only matches');
    expect(screen.getByText('Example candidate')).toHaveAttribute('href', `/admin/users/${'2'.repeat(24)}`);
    expect(screen.getByText("flagged account's signup IP")).toHaveAttribute(
      'href',
      `/admin/users/${'1'.repeat(24)}?tab=signins`
    );
    expect(screen.getByTestId('admin-dashboard-ai-advisory-summary')).toHaveTextContent('1 account likely abuse');
  });
  it('shows only the failed alert when the linked-account check failed', () => {
    mocks.data = summary({ advisories: [advisory('1'.repeat(24), 'accountCampaign')], linkedAccountsStatus: 'failed' });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.getByText('Linked accounts could not be checked.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('The linked-account scan reached a cap.', { exact: false })).not.toBeInTheDocument();
  });

  it('shows only the cap alert when the linked-account scan was truncated', () => {
    mocks.data = summary({
      advisories: [advisory('1'.repeat(24), 'accountCampaign')],
      linkedAccountsStatus: 'truncated',
    });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    expect(screen.getByText('The linked-account scan reached a cap.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Linked accounts could not be checked.', { exact: false })).not.toBeInTheDocument();
  });

  it('navigates within the SPA when either related-account link is clicked', () => {
    const candidateId = '2'.repeat(24);
    const sourceId = '1'.repeat(24);
    mocks.data = summary({
      advisories: [advisory(sourceId, 'accountCampaign')],
      linkedAccounts: [
        {
          userId: candidateId,
          name: 'Example candidate',
          links: [{ sourceUserId: sourceId, ip: '198.51.100.10', sourceKind: 'signup', candidateKind: 'login' }],
        },
      ],
    });
    render(<AiAdvisoryStrip />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId(`ai-advisory-linked-account-${candidateId}`));
    expect(mocks.navigate).toHaveBeenNthCalledWith(1, {
      to: '/admin/users/$userId',
      params: { userId: candidateId },
    });
    fireEvent.click(
      screen.getByTestId(`ai-advisory-linked-source-${candidateId}-${sourceId}-198.51.100.10-signup-login`)
    );
    expect(mocks.navigate).toHaveBeenNthCalledWith(2, {
      to: '/admin/users/$userId',
      params: { userId: sourceId },
      search: { tab: 'signins' },
    });
  });
});

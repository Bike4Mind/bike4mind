import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import WaitlistTab from './WaitlistTab';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  fetchSubscribers: vi.fn(),
  fetchGrantPackages: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));
vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  fetchGrantPackages: mocks.fetchGrantPackages,
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
}));
vi.mock('@client/app/utils/subscriberAPICalls', () => ({
  fetchSubscribers: mocks.fetchSubscribers,
  deleteSubscriber: vi.fn(),
}));
vi.mock('@client/app/hooks/data/subscribers', () => ({ useGetWaitingSubscribersCount: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('./AdminPage', () => ({
  useAdminNotifications: (select: (state: unknown) => unknown) =>
    select({ hiddenNotifications: [], hideNotification: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const SUBSCRIBER = {
  id: 'sub-1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  createdAt: '2026-01-01T00:00:00.000Z',
  inviteGenerated: false,
};

const openInviteDialog = async () => {
  render(<WaitlistTab />, { wrapper: Wrapper });
  fireEvent.click(await screen.findByRole('button', { name: /generate invite/i }));
  return screen.getByTestId('waitlist-invite-dialog-confirm-btn');
};

describe('WaitlistTab invite dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchSubscribers.mockResolvedValue({ data: [SUBSCRIBER], meta: { total: 1 } });
    mocks.post.mockResolvedValue({ data: { emailSent: true } });
    mocks.fetchGrantPackages.mockResolvedValue({
      data: [{ id: 'pkg1', name: 'Launch pack', credits: 750, storageMb: 2048, totalCap: 10, dailyCap: null }].map(
        pkg => ({ ...pkg, redeemedTotal: 0, redeemedToday: 0, capHits: 0, active: true })
      ),
      meta: { total: 1, page: 1, limit: 100, totalPages: 1 },
      reasonPolicy: {},
    });
  });

  it('keeps the invite locked until a reason is given', async () => {
    const confirm = await openInviteDialog();

    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('waitlist-invite-dialog-hint')).toBeInTheDocument();
  });

  it('sends the unchanged invite payload, without the reason, once a reason is picked', async () => {
    const confirm = await openInviteDialog();

    fireEvent.click(screen.getByTestId('waitlist-invite-dialog-reason-input-preset-0'));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.post.mock.calls[0];
    expect(url).toBe('/api/subscribers/generate-invite');
    expect(Object.keys(body).sort()).toEqual(
      ['email', 'emailBody', 'firstName', 'lastName', 'startingCredits', 'startingStorage', 'subscriberId'].sort()
    );
    expect(body).toMatchObject({ subscriberId: 'sub-1', startingCredits: 500, startingStorage: 1000 });
  });

  it('sends the selected grant package and describes its amounts in the default email', async () => {
    const confirm = await openInviteDialog();

    const select = screen.getByTestId('waitlist-invite-grant-package-select');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.click(select);
    fireEvent.click(await screen.findByTestId('waitlist-invite-grant-package-select-option-pkg1'));
    expect(screen.getByTestId('waitlist-invite-credits-input')).toHaveValue(750);
    expect(screen.getByTestId('waitlist-invite-storage-input')).toHaveValue(2048);
    fireEvent.click(screen.getByTestId('waitlist-invite-dialog-reason-input-preset-0'));
    await waitFor(() => expect(confirm).toBeEnabled());
    const packageFetchesBeforeSend = mocks.fetchGrantPackages.mock.calls.length;
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [, body] = mocks.post.mock.calls[0];
    expect(body.grantPackageId).toBe('pkg1');
    expect(body.emailBody).toContain('750 credits');
    expect(body.emailBody).toContain('2048 MB');
    await waitFor(() => expect(mocks.fetchGrantPackages.mock.calls.length).toBeGreaterThan(packageFetchesBeforeSend));
  });
});

describe('WaitlistTab Invite Center', () => {
  it('shows the Invite Center header with the waitlist in the Waitlist section', async () => {
    mocks.fetchSubscribers.mockResolvedValue({ data: [SUBSCRIBER], meta: { total: 1 } });
    render(<WaitlistTab />, { wrapper: Wrapper });

    expect(screen.getByText('Invite Center')).toBeInTheDocument();
    const section = screen.getByTestId('invite-center-section-waitlist');
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(section).toContainElement(screen.getByText('ada@example.com'));
  });
});

describe('WaitlistTab network and payload signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchGrantPackages.mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } });
  });

  it('renders a payload name as text, badges it and summarises the network with details on expand', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    mocks.fetchSubscribers.mockResolvedValue({
      data: [
        {
          ...SUBSCRIBER,
          firstName: payload,
          lastName: '<b>bold</b>',
          suspicious: { reasons: ['markup'] },
          signupNetwork: {
            ipPrefix: '203.0.113.0',
            userAgent: 'curl/8.4',
            asn: 64500,
            asnOrg: 'Example Hosting',
            country: 'NL',
            isDatacenter: true,
            ja4: null,
            wafAnonIp: true,
            wafBotSignal: null,
            challengeVerified: true,
            capturedAt: '2026-10-30T00:00:00.000Z',
          },
        },
      ],
      meta: { total: 1 },
    });
    const { container } = render(<WaitlistTab />, { wrapper: Wrapper });

    expect(await screen.findByText(`${payload} <b>bold</b>`)).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByTestId('waitlist-suspicious-chip')).toHaveTextContent('Payload-like name');
    expect(screen.getByTestId('waitlist-network-cell')).toHaveTextContent('NL');
    expect(screen.getByTestId('waitlist-network-cell')).toHaveTextContent('Example Hosting');
    expect(screen.getByTestId('waitlist-anon-ip-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('waitlist-network-details')).toBeNull();

    fireEvent.click(screen.getByTestId('waitlist-network-toggle'));
    const details = screen.getByTestId('waitlist-network-details');
    expect(details).toHaveTextContent('203.0.113.0');
    expect(details).toHaveTextContent('curl/8.4');
    expect(details).toHaveTextContent('Turnstile: passed');
    expect(details).toHaveTextContent('Bot signal (WAF): not checked');
  });

  it('shows a dash and no badge for a row without network capture', async () => {
    mocks.fetchSubscribers.mockResolvedValue({ data: [SUBSCRIBER], meta: { total: 1 } });
    render(<WaitlistTab />, { wrapper: Wrapper });

    expect(await screen.findByTestId('waitlist-network-none')).toBeInTheDocument();
    expect(screen.queryByTestId('waitlist-suspicious-chip')).toBeNull();
  });
});

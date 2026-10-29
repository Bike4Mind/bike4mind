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
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));
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
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import SignupDomainHoldsTab from './SignupDomainHoldsTab';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: getMock, post: postMock } }));

const theme = extendTheme({ ...getThemeConfig() });
const endpoint = '/api/admin/signup-domain-holds';
const reviewInputs = [
  ['alpha.test', 'held_pending_review'],
  ['beta.test', 'blocked'],
  ['gamma.test', 'released'],
] as const;
const reviews: SignupDomainReview[] = reviewInputs.map(([domain, status]) => ({
  domain,
  status,
  reason: 'Generated signup pattern',
  triggeredAt: new Date('2026-01-01'),
  cohortUserIds: [],
  sampleEmails: [`user@${domain}`],
  signupCount: 5,
}));

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <SignupDomainHoldsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { data: reviews, total: 50 } });
});

describe('SignupDomainHoldsTab', () => {
  it('uses server pagination without a second local pager', async () => {
    renderTab();
    expect(await screen.findByTestId('signup-domain-confirm-alpha.test')).toBeEnabled();
    expect(screen.getByTestId('signup-domain-confirm-beta.test')).toBeDisabled();
    expect(screen.getByTestId('signup-domain-confirm-gamma.test')).toBeDisabled();
    expect(screen.getByTestId('signup-domain-release-gamma.test')).toHaveTextContent('Retry pending grants');
    expect(screen.queryByTestId('admin-table-page-size')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-next-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('signup-domain-holds-next'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, { params: { page: 2 } }));
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeDisabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-previous'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, { params: { page: 1 } }));
  });

  it('sends one decision for a double-click', async () => {
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    const confirm = await screen.findByTestId('signup-domain-confirm-alpha.test');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Domain confirmed; pending credits remain held.')).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('keeps each domain release cursor when retrying pending grants', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { status: 'released', creditsReleased: 5, remaining: 1, nextCursor: 'alpha-cursor' },
      })
      .mockResolvedValueOnce({
        data: { status: 'released', creditsReleased: 5, remaining: 1, nextCursor: 'beta-cursor' },
      })
      .mockResolvedValue({ data: { status: 'released', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    fireEvent.click(await screen.findByTestId('signup-domain-release-alpha.test'));
    await waitFor(() => expect(screen.getByTestId('signup-domain-release-beta.test')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-release-beta.test'));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('signup-domain-release-alpha.test')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-release-alpha.test'));
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith(endpoint, {
        domain: 'alpha.test',
        action: 'release',
        afterUserId: 'alpha-cursor',
      })
    );
  });
});

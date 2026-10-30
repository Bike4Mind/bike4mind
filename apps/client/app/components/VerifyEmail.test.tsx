import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { post, refreshUser } = vi.hoisted(() => ({ post: vi.fn(), refreshUser: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', emailVerified: false }, refreshUser }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('next/image', () => ({ default: () => null }));

import VerifyEmail from './VerifyEmail';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderVerification = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } } });
  queryClient.setQueryData(['gears', 'status'], {
    gears: [{ key: 'projects', unlocked: true, rewardPending: true, pendingReason: 'unverified' }],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <VerifyEmail token="verification-token" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return queryClient;
};

beforeEach(() => {
  post.mockReset();
  refreshUser.mockReset();
  refreshUser.mockResolvedValue(undefined);
});

describe('VerifyEmail gear reward cache', () => {
  it('invalidates cached unverified gear rewards after verification succeeds', async () => {
    post.mockResolvedValue({ data: {} });
    const queryClient = renderVerification();
    await screen.findByTestId('verify-email-success');
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/email/verify', { token: 'verification-token' });
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(['gears', 'status'])?.isInvalidated).toBe(true);

    // Returning to Gears must fetch the server's new trust state despite the five-minute staleTime.
    const fetchStatus = vi.fn().mockResolvedValue({ gears: [{ key: 'projects', claimable: true }] });
    const status = await queryClient.fetchQuery({ queryKey: ['gears', 'status'], queryFn: fetchStatus });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(status.gears[0].claimable).toBe(true);
    queryClient.clear();
  });

  it('keeps the pending cache intact when verification fails', async () => {
    post.mockRejectedValue(new Error('Expired verification token'));
    const queryClient = renderVerification();
    await screen.findByTestId('verify-email-error');
    expect(queryClient.getQueryState(['gears', 'status'])?.isInvalidated).toBe(false);
    expect(refreshUser).not.toHaveBeenCalled();
    queryClient.clear();
  });
});

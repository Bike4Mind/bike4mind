// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AxiosError } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminSubscriptionByStripeId from './$stripeSubscriptionId';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ stripeSubscriptionId: 'sub_123' }),
  useNavigate: () => mockNavigate,
}));

const mockLookup = vi.fn();
vi.mock('@client/app/hooks/data/adminSubscriptionDetail', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/adminSubscriptionDetail')>()),
  useAdminSubscriptionIdByStripeId: (...a: unknown[]) => mockLookup(...a),
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminSubscriptionByStripeId />
    </CssVarsProvider>
  );

const notFound = () => Object.assign(new AxiosError('nope'), { response: { status: 404 } });

describe('AdminSubscriptionByStripeId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLookup.mockReturnValue({ data: undefined, error: null, isError: false, isFetching: true, refetch: vi.fn() });
  });

  it('shows the loading bar while the lookup is pending', () => {
    renderPage();
    expect(screen.getByTestId('subscription-by-stripe-loading')).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders the error state and retries through refetch on a generic failure', () => {
    const refetch = vi.fn();
    mockLookup.mockReturnValue({
      data: undefined,
      error: new Error('boom'),
      isError: true,
      isFetching: false,
      refetch,
    });
    renderPage();

    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('subscription-by-stripe-not-found')).toBeNull();
  });

  it('shows not-found and navigates back to the subscriptions tab', () => {
    mockLookup.mockReturnValue({
      data: undefined,
      error: notFound(),
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByTestId('subscription-by-stripe-not-found')).toBeTruthy();
    fireEvent.click(screen.getByTestId('subscription-by-stripe-back-btn'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin', search: { [ADMIN_TAB_PARAM]: 'subscriptions' } });
  });

  it('replaces the route with the resolved subscription detail page', () => {
    mockLookup.mockReturnValue({
      data: { id: 'abc' },
      error: null,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    renderPage();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: 'abc' },
      replace: true,
    });
  });
});

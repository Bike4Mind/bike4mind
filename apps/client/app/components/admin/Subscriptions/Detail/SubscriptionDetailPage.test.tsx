import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { SubscriptionDetailPage } from './SubscriptionDetailPage';
import { SUBSCRIPTION_ID, SubscriptionTestWrapper, buildDetail } from './subscriptionDetailTestUtils';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), useAdminSubscriptionDetail: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/hooks/data/adminSubscriptionDetail', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/adminSubscriptionDetail')>()),
  useAdminSubscriptionDetail: mocks.useAdminSubscriptionDetail,
}));
// The view is covered through its parts; this stub exposes the props the page wires.
vi.mock('./SubscriptionDetailView', () => ({
  SubscriptionDetailView: (props: { detail: { subscription: { id: string } }; tab: string }) => (
    <div data-testid="stub-subscription-detail-view" data-tab={props.tab} data-id={props.detail.subscription.id} />
  ),
}));

const query = (overrides: Record<string, unknown>) => ({
  isLoading: false,
  isFetching: false,
  error: null,
  data: undefined,
  refetch: vi.fn(),
  ...overrides,
});

const notFoundError = () =>
  new AxiosError('Not found', '404', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const renderPage = (subscriptionId = SUBSCRIPTION_ID) =>
  render(<SubscriptionDetailPage subscriptionId={subscriptionId} tab="admin" onTabChange={vi.fn()} />, {
    wrapper: SubscriptionTestWrapper,
  });

describe('SubscriptionDetailPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the view once the detail loads', () => {
    mocks.useAdminSubscriptionDetail.mockReturnValue(query({ data: buildDetail() }));
    renderPage();
    const view = screen.getByTestId('stub-subscription-detail-view');
    expect(view).toHaveAttribute('data-tab', 'admin');
    expect(view).toHaveAttribute('data-id', SUBSCRIPTION_ID);
  });

  it('shows a skeleton while loading', () => {
    mocks.useAdminSubscriptionDetail.mockReturnValue(query({ isLoading: true, isFetching: true }));
    renderPage();
    expect(screen.getByTestId('subscription-detail-loading')).toBeInTheDocument();
  });

  it('treats a 404 as not found and goes back to the list', () => {
    mocks.useAdminSubscriptionDetail.mockReturnValue(query({ error: notFoundError() }));
    renderPage();
    expect(screen.getByTestId('subscription-detail-not-found')).toHaveTextContent('Subscription not found');
    fireEvent.click(screen.getByTestId('subscription-detail-not-found-back-btn'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'subscriptions' } });
  });

  it('treats a malformed id as not found', () => {
    mocks.useAdminSubscriptionDetail.mockReturnValue(query({}));
    renderPage('../users');
    expect(screen.getByTestId('subscription-detail-not-found')).toBeInTheDocument();
  });

  it('offers Try again on any other failure', () => {
    const refetch = vi.fn();
    mocks.useAdminSubscriptionDetail.mockReturnValue(query({ error: new Error('boom'), refetch }));
    renderPage();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });
});

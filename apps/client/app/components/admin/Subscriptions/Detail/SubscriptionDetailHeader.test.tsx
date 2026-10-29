import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { SubscriptionDetailHeader } from './SubscriptionDetailHeader';
import { NO_ACTING_USER_REASON, REMOVE_LIVE_STRIPE_REASON } from './subscriptionDetailModel';
import { OWNER_ID, STRIPE_ROW, SubscriptionTestWrapper, buildDetail } from './subscriptionDetailTestUtils';

const setup = (detail: AdminSubscriptionDetail) => {
  const onAction = vi.fn();
  const onOpenOwner = vi.fn();
  render(<SubscriptionDetailHeader detail={detail} onAction={onAction} onOpenOwner={onOpenOwner} />, {
    wrapper: SubscriptionTestWrapper,
  });
  fireEvent.click(screen.getByTestId('subscription-detail-more-btn'));
  return { onAction, onOpenOwner };
};

const menuItem = (name: 'credits' | 'remove') => screen.queryByTestId(`subscription-detail-menu-${name}-item`);

describe('SubscriptionDetailHeader', () => {
  it('shows a live comp with Extend, End and both menu items', () => {
    const { onAction } = setup(buildDetail());

    expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByTestId('subscription-detail-status-chip')).toHaveTextContent('Active');
    expect(screen.getByTestId('subscription-detail-comped-chip')).toHaveTextContent('Comped');

    fireEvent.click(screen.getByTestId('subscription-detail-extend-btn'));
    expect(onAction).toHaveBeenLastCalledWith('extend');
    fireEvent.click(screen.getByTestId('subscription-detail-end-btn'));
    expect(onAction).toHaveBeenLastCalledWith('end');

    expect(menuItem('credits')).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(menuItem('remove') as HTMLElement);
    expect(onAction).toHaveBeenLastCalledWith('remove');
  });

  it('gives a live Stripe row only the More menu, with Remove disabled and explained', () => {
    const { onAction } = setup(buildDetail({ subscription: STRIPE_ROW }));

    expect(screen.queryByTestId('subscription-detail-extend-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-detail-end-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-detail-comped-chip')).not.toBeInTheDocument();
    expect(menuItem('credits')).toBeInTheDocument();
    expect(menuItem('remove')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('subscription-detail-menu-remove-item-reason')).toHaveTextContent(
      REMOVE_LIVE_STRIPE_REASON
    );
    fireEvent.click(menuItem('remove') as HTMLElement);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('gives an ended row Remove only, with no comp actions or credits', () => {
    setup(buildDetail({ subscription: { status: 'canceled' } }));

    expect(screen.getByTestId('subscription-detail-status-chip')).toHaveTextContent('Canceled');
    expect(screen.queryByTestId('subscription-detail-comped-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-detail-extend-btn')).not.toBeInTheDocument();
    expect(menuItem('credits')).not.toBeInTheDocument();
    expect(menuItem('remove')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disables credits and remove in place when no account can act for the owner', () => {
    setup(buildDetail({ actingUserId: null }));

    expect(screen.getByTestId('subscription-detail-extend-btn')).toBeEnabled();
    expect(menuItem('credits')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('subscription-detail-menu-credits-item-reason')).toHaveTextContent(NO_ACTING_USER_REASON);
    expect(menuItem('remove')).toHaveAttribute('aria-disabled', 'true');
  });

  it('links the owner to their profile', () => {
    const { onOpenOwner } = setup(buildDetail());
    fireEvent.click(screen.getByTestId('subscription-detail-owner-link'));
    expect(onOpenOwner).toHaveBeenCalledWith({ kind: 'user', userId: OWNER_ID });
  });
});

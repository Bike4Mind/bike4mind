import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SubscriptionDetailView } from './SubscriptionDetailView';
import { buildDetail, STRIPE_ROW, SubscriptionTestWrapper } from './subscriptionDetailTestUtils';

vi.mock('./SubscriptionDetailHeader', () => ({
  SubscriptionDetailHeader: ({ onAction }: { onAction: (action: string) => void }) => (
    <>
      <button data-testid="view-test-cancel" onClick={() => onAction('cancel')} />
      <button data-testid="view-test-resume" onClick={() => onAction('resume')} />
    </>
  ),
}));
vi.mock('./SubscriptionDetailStats', () => ({ SubscriptionDetailStats: () => null }));
vi.mock('./SubscriptionDetailTabs', () => ({
  SubscriptionDetailTabs: () => null,
  subscriptionDetailPanelId: () => 'panel',
  subscriptionDetailTabId: () => 'tab',
}));
vi.mock('./tabs/OverviewTab', () => ({ OverviewTab: () => null }));
vi.mock('./tabs/SubscriptionAdminLogTab', () => ({ SubscriptionAdminLogTab: () => null }));
vi.mock('./actions/ExtendCompDialog', () => ({ ExtendCompDialog: () => null }));
vi.mock('./actions/EndCompDialog', () => ({ EndCompDialog: () => null }));
vi.mock('./actions/EditCreditsPerCycleDialog', () => ({ EditCreditsPerCycleDialog: () => null }));
vi.mock('./actions/RemoveSubscriptionDialog', () => ({ RemoveSubscriptionDialog: () => null }));
vi.mock('./actions/CancelSubscriptionDialog', () => ({
  CancelSubscriptionDialog: () => <div data-testid="stub-cancel-dialog" />,
}));
vi.mock('./actions/ResumeSubscriptionDialog', () => ({
  ResumeSubscriptionDialog: () => <div data-testid="stub-resume-dialog" />,
}));

const navigation = { backToList: vi.fn() } as never;

const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();
const cancellable = () => buildDetail({ subscription: STRIPE_ROW });
const resumable = () => buildDetail({ subscription: { ...STRIPE_ROW, periodEndsAt: FUTURE, cancelAt: FUTURE } });

const renderView = (detail: ReturnType<typeof buildDetail>) =>
  render(<SubscriptionDetailView detail={detail} tab="overview" onTabChange={vi.fn()} navigation={navigation} />, {
    wrapper: SubscriptionTestWrapper,
  });

describe('SubscriptionDetailView', () => {
  it('opens the cancel dialog for the cancel action', () => {
    renderView(cancellable());
    fireEvent.click(screen.getByTestId('view-test-cancel'));
    expect(screen.getByTestId('stub-cancel-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-resume-dialog')).not.toBeInTheDocument();
  });

  it('opens the resume dialog for the resume action', () => {
    renderView(resumable());
    fireEvent.click(screen.getByTestId('view-test-resume'));
    expect(screen.getByTestId('stub-resume-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-cancel-dialog')).not.toBeInTheDocument();
  });

  it('closes the cancel dialog when a refetch shows a cancellation is now scheduled', () => {
    const { rerender } = renderView(cancellable());
    fireEvent.click(screen.getByTestId('view-test-cancel'));
    expect(screen.getByTestId('stub-cancel-dialog')).toBeInTheDocument();

    rerender(
      <SubscriptionDetailView detail={resumable()} tab="overview" onTabChange={vi.fn()} navigation={navigation} />
    );
    expect(screen.queryByTestId('stub-cancel-dialog')).not.toBeInTheDocument();
  });

  it('closes the resume dialog when a refetch shows the cancellation is gone', () => {
    const { rerender } = renderView(resumable());
    fireEvent.click(screen.getByTestId('view-test-resume'));
    expect(screen.getByTestId('stub-resume-dialog')).toBeInTheDocument();

    rerender(
      <SubscriptionDetailView detail={cancellable()} tab="overview" onTabChange={vi.fn()} navigation={navigation} />
    );
    expect(screen.queryByTestId('stub-resume-dialog')).not.toBeInTheDocument();
  });
});

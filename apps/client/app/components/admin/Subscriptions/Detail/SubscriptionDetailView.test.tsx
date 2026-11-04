import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SubscriptionDetailView } from './SubscriptionDetailView';
import { buildDetail, SubscriptionTestWrapper } from './subscriptionDetailTestUtils';

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

describe('SubscriptionDetailView', () => {
  it('opens the cancel dialog for the cancel action and the resume dialog for the resume action', () => {
    render(
      <SubscriptionDetailView detail={buildDetail()} tab="overview" onTabChange={vi.fn()} navigation={navigation} />,
      {
        wrapper: SubscriptionTestWrapper,
      }
    );

    fireEvent.click(screen.getByTestId('view-test-cancel'));
    expect(screen.getByTestId('stub-cancel-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-resume-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('view-test-resume'));
    expect(screen.getByTestId('stub-resume-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-cancel-dialog')).not.toBeInTheDocument();
  });
});

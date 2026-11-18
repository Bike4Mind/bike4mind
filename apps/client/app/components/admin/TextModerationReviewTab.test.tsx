import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { review, update, currentUser } = vi.hoisted(() => ({
  review: vi.fn(),
  update: vi.fn(),
  currentUser: { current: { id: 'admin1', isAdmin: true } as Record<string, unknown> },
}));

vi.mock('@client/app/hooks/data/textModerationReview', () => ({
  TEXT_MODERATION_REVIEW_QUERY_KEY: ['admin-text-moderation-review'],
  useTextModerationReview: () => review(),
}));
vi.mock('./Users/Profile/actions/useAdminUserUpdate', () => ({ useAdminUserUpdate: () => update }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: currentUser.current }) }));

import { TextModerationReviewTab } from './TextModerationReviewTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const hit = (categories: string[]) => ({ at: new Date().toISOString(), categories, source: 'openai' });
const row = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `User ${id}`,
  email: `${id}@example.test`,
  createdAt: null,
  hasUnreviewedSevereHit: false,
  moderation: { status, hitCount: 1, lastHitAt: null, hits: [hit(['violence'])], ...overrides },
});

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <TextModerationReviewTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { invalidate };
};

const loaded = (users: unknown[]) =>
  review.mockReturnValue({ data: users, isPending: false, error: null, refetch: vi.fn() });

const decide = (id: string, decision: string) => {
  fireEvent.click(screen.getByTestId(`text-moderation-row-actions-${id}`));
  fireEvent.click(screen.getByTestId(`text-moderation-row-${decision}-${id}`));
};

beforeEach(() => {
  review.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  currentUser.current = { id: 'admin1', isAdmin: true };
});

describe('TextModerationReviewTab', () => {
  it('sends the decision with its reason, then refreshes the list and closes the dialog', async () => {
    loaded([row('u1', 'suspend_pending')]);
    const { invalidate } = renderTab();

    decide('u1', 'suspended');
    fireEvent.click(screen.getByTestId('text-moderation-suspended-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('text-moderation-suspended-dialog-confirm-btn'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({
      moderationStatus: 'suspended',
      statusChangeReason: expect.any(String),
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-text-moderation-review'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
    await waitFor(() => expect(screen.queryByTestId('text-moderation-suspended-dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and does not refresh when the update is rejected', async () => {
    update.mockRejectedValue(new Error('nope'));
    loaded([row('u1', 'suspend_pending')]);
    const { invalidate } = renderTab();

    decide('u1', 'throttled');
    fireEvent.click(screen.getByTestId('text-moderation-throttled-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('text-moderation-throttled-dialog-confirm-btn'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('text-moderation-throttled-dialog')).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('shows Retry on a load error and refetches', () => {
    const refetch = vi.fn();
    review.mockReturnValue({ data: undefined, isPending: false, error: new Error('x'), refetch });
    renderTab();

    expect(screen.getByText("Couldn't load the review list.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('offers Return to active to an active user with an unreviewed severe hit', () => {
    loaded([{ ...row('u1', 'active', { hits: [hit(['sexual/minors'])] }), hasUnreviewedSevereHit: true }]);
    renderTab();

    expect(screen.getByText('Severe category')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('text-moderation-row-actions-u1'));
    expect(screen.getByTestId('text-moderation-row-active-u1')).toBeInTheDocument();
  });

  it('hides Return to active from an active user with no severe hit, and offers no actions on a suspended one', () => {
    loaded([row('u1', 'active'), row('u2', 'suspended')]);
    renderTab();

    fireEvent.click(screen.getByTestId('text-moderation-row-actions-u1'));
    expect(screen.queryByTestId('text-moderation-row-active-u1')).not.toBeInTheDocument();
    expect(screen.getByTestId('text-moderation-row-throttled-u1')).toBeInTheDocument();
  });

  it('disables the row menu without users:moderate', () => {
    currentUser.current = { id: 'reader', isAdmin: false, adminPermissions: ['support:read'] };
    loaded([row('u1', 'throttled')]);
    renderTab();

    expect(screen.getByTestId('text-moderation-row-actions-u1')).toBeDisabled();
  });

  it('shows the empty state with no users', () => {
    loaded([]);
    renderTab();

    expect(screen.getByText('No users need review')).toBeInTheDocument();
  });
});

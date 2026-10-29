import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SignupRiskReviewRow } from '@client/app/hooks/data/signupRiskReviews';
import { UndoToastProvider } from './shared';

// The data hooks are mocked so each path is driven directly; the route behind them is covered by
// pages/api/admin/__tests__/signup-risk-reviews.test.ts.
const m = vi.hoisted(() => ({
  useSignupRiskReviews: vi.fn(),
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  openProfile: vi.fn(),
  bulkAbuse: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('@client/app/hooks/data/signupRiskReviews', () => ({
  useSignupRiskReviews: m.useSignupRiskReviews,
  useSignupRiskReviewDecision: () => ({
    mutate: m.mutate,
    mutateAsync: m.mutateAsync,
    reset: m.reset,
    isPending: false,
    error: null,
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => m.search, useNavigate: () => m.navigate }));
vi.mock('./Users/Profile/useOpenUserProfile', () => ({ useOpenUserProfile: () => m.openProfile }));
vi.mock('./Users/BulkAbuseResponseModal', () => ({
  default: (props: { selectedUserIds: string[]; onExecuted: () => void }) => {
    m.bulkAbuse(props.selectedUserIds);
    return (
      <button type="button" data-testid="bulk-abuse-stub" onClick={props.onExecuted}>
        stub
      </button>
    );
  },
}));

import SignupRiskReviewTab from './SignupRiskReviewTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <UndoToastProvider>
        <SignupRiskReviewTab />
      </UndoToastProvider>
    </CssVarsProvider>
  );

const row = (over: Partial<SignupRiskReviewRow> = {}): SignupRiskReviewRow => ({
  userId: 'u1',
  email: 'bot1@burner-example.com',
  username: 'bot1',
  domain: 'burner-example.com',
  createdAt: '2026-10-20T10:00:00.000Z',
  score: 80,
  signals: [{ signal: 'quickApiKey', points: 15, reason: 'First API key created 3 minutes after signup' }],
  computedAt: '2026-10-20T11:00:00.000Z',
  creditsSpent: 1200,
  apiKeysCreated: 3,
  ...over,
});

const ROWS = [
  row(),
  row({
    userId: 'u2',
    email: 'jane@example.org',
    username: 'jane',
    domain: 'example.org',
    score: 55,
    signals: [{ signal: 'fastSpend', points: 20, reason: 'Spent 900 credits in the first hour' }],
    creditsSpent: 0,
    apiKeysCreated: 0,
  }),
];

const queue = (data: SignupRiskReviewRow[], over: Record<string, unknown> = {}) => ({
  data: { data, truncated: false, reviewThreshold: 50 },
  error: null,
  isPending: false,
  refetch: vi.fn(),
  ...over,
});

const approveFirstRow = async () => {
  fireEvent.click(screen.getByTestId('signup-risk-actions-u1'));
  fireEvent.click(await screen.findByTestId('signup-risk-approve-u1'));
  fireEvent.click(await screen.findByTestId('signup-risk-approve-reason-preset-0'));
  fireEvent.click(screen.getByTestId('signup-risk-approve-confirm-btn'));
};

beforeEach(() => {
  vi.clearAllMocks();
  m.search = {};
  m.useSignupRiskReviews.mockReturnValue(queue(ROWS));
});

describe('SignupRiskReviewTab', () => {
  it('lists flagged accounts with their risk tone, signals and activity', () => {
    renderTab();

    const high = screen.getByTestId('signup-risk-row-u1');
    expect(within(high).getByText('High risk')).toBeTruthy();
    expect(within(high).getByText('Quick API key')).toBeTruthy();
    expect(within(high).getByText('1,200')).toBeTruthy();
    expect(within(screen.getByTestId('signup-risk-row-u2')).getByText('Medium risk')).toBeTruthy();
    expect(screen.queryByTestId('signup-risk-truncated')).toBeNull();
  });

  it('puts the high risk cut halfway between a custom review threshold and 100', () => {
    m.useSignupRiskReviews.mockReturnValue(queue(ROWS, { data: { data: ROWS, truncated: false, reviewThreshold: 20 } }));
    renderTab();

    expect(within(screen.getByTestId('signup-risk-row-u1')).getByText('High risk')).toBeTruthy();
    expect(within(screen.getByTestId('signup-risk-row-u2')).getByText('Medium risk')).toBeTruthy();
  });

  it('shows the username only when it differs from the email local part', () => {
    m.useSignupRiskReviews.mockReturnValue(queue([row(), row({ userId: 'u3', username: 'renamed-bot' })]));
    renderTab();

    expect(within(screen.getByTestId('signup-risk-row-u1')).queryByText('bot1')).toBeNull();
    expect(within(screen.getByTestId('signup-risk-row-u3')).getByText('renamed-bot')).toBeTruthy();
  });

  it('says when the queue is capped', () => {
    m.useSignupRiskReviews.mockReturnValue({ ...queue(ROWS), data: { data: ROWS, truncated: true, reviewThreshold: 50 } });
    renderTab();

    expect(screen.getByTestId('signup-risk-truncated')).toBeTruthy();
  });

  it('filters by the signal in the URL and offers to clear it when nothing matches', () => {
    m.search = { riskSignal: 'fastSpend' };
    const { unmount } = renderTab();
    expect(screen.queryByTestId('signup-risk-row-u1')).toBeNull();
    expect(screen.getByTestId('signup-risk-row-u2')).toBeTruthy();
    unmount();

    m.search = { riskSignal: 'datacenterNetwork' };
    renderTab();
    expect(screen.getByText('No matching accounts')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear filters'));
    expect(m.navigate).toHaveBeenCalled();
  });

  it('keeps the email search out of the URL', () => {
    renderTab();

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'jane' } });

    expect(screen.queryByTestId('signup-risk-row-u1')).toBeNull();
    expect(screen.getByTestId('signup-risk-row-u2')).toBeTruthy();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('approves with a required reason and offers an undo that reopens the review', async () => {
    m.mutate.mockImplementation((_decision, options: { onSuccess: (result: unknown) => void }) =>
      options.onSuccess({ updatedUserIds: ['u1'], skippedUserIds: [], failedUserIds: [] })
    );
    m.mutateAsync.mockResolvedValue({ updatedUserIds: ['u1'], skippedUserIds: [], failedUserIds: [] });
    renderTab();

    await approveFirstRow();

    expect(m.openProfile).not.toHaveBeenCalled();
    expect(m.mutate).toHaveBeenCalledWith(
      { action: 'approve', userIds: ['u1'], reason: 'Verified legitimate user' },
      expect.anything()
    );
    expect(screen.getByTestId('undo-toast-message').textContent).toBe('Approved 1 account');

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({
        action: 'reopen',
        userIds: ['u1'],
        reason: 'Undid approval: Verified legitimate user',
      })
    );
  });

  it('reports accounts that failed while still offering undo for the rest', async () => {
    m.mutate.mockImplementation((_decision, options: { onSuccess: (result: unknown) => void }) =>
      options.onSuccess({ updatedUserIds: ['u1'], skippedUserIds: [], failedUserIds: ['u2'] })
    );
    renderTab();

    await approveFirstRow();

    expect(screen.getByTestId('signup-risk-failed').textContent).toContain('1 account could not be approved');
    expect(screen.getByTestId('undo-toast-message').textContent).toBe('Approved 1 account');
  });

  it('clears a stale decision error when the approve dialog opens', () => {
    renderTab();

    fireEvent.click(screen.getByTestId('signup-risk-actions-u1'));
    fireEvent.click(screen.getByTestId('signup-risk-approve-u1'));

    expect(m.reset).toHaveBeenCalled();
  });

  it('offers no undo when every account was already decided elsewhere', async () => {
    m.mutate.mockImplementation((_decision, options: { onSuccess: (result: unknown) => void }) =>
      options.onSuccess({ updatedUserIds: [], skippedUserIds: ['u1'], failedUserIds: [] })
    );
    renderTab();

    await approveFirstRow();

    expect(m.mutate).toHaveBeenCalled();
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it('suspends the selection through the bulk abuse response dialog', () => {
    renderTab();

    for (const id of ['u1', 'u2'])
      fireEvent.click(within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('signup-risk-bulk-suspend-btn'));

    expect(m.bulkAbuse).toHaveBeenCalledWith(['u1', 'u2']);
    fireEvent.click(screen.getByTestId('bulk-abuse-stub'));
    expect(m.useSignupRiskReviews.mock.results[0].value.refetch).toHaveBeenCalled();
    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
  });

  it('suspends one account from its row menu without opening the profile', async () => {
    renderTab();

    fireEvent.click(screen.getByTestId('signup-risk-actions-u2'));
    fireEvent.click(await screen.findByTestId('signup-risk-suspend-u2'));

    expect(m.bulkAbuse).toHaveBeenCalledWith(['u2']);
    expect(m.openProfile).not.toHaveBeenCalled();
  });

  it('opens the user profile when a row is activated', () => {
    renderTab();

    fireEvent.click(screen.getByTestId('signup-risk-row-u2'));

    expect(m.openProfile).toHaveBeenCalledWith('u2');
  });

  it('shows an empty queue with a refresh action', () => {
    const empty = queue([]);
    m.useSignupRiskReviews.mockReturnValue(empty);
    renderTab();

    expect(screen.getByText('No accounts are waiting for review')).toBeTruthy();
    fireEvent.click(screen.getByTestId('signup-risk-reset-btn'));
    expect(empty.refetch).toHaveBeenCalled();
  });
});

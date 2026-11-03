import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { StripeDisputeListResponse, StripeDisputeRow } from '@client/app/hooks/data/stripeDisputes';

const m = vi.hoisted(() => ({
  useStripeDisputes: vi.fn(),
  resolve: vi.fn(),
  undo: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock('@client/app/hooks/data/stripeDisputes', () => ({
  useStripeDisputes: m.useStripeDisputes,
  useResolveStripeDispute: () => ({ mutateAsync: m.resolve, isPending: false, error: null }),
  useUndoContainStripeDispute: () => ({ mutateAsync: m.undo, isPending: false, error: null }),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => m.search,
  useNavigate: () => m.navigate,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace('$userId', params.userId)} {...rest}>
      {children}
    </a>
  ),
}));

import StripeDisputesTab from './StripeDisputesTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <StripeDisputesTab />
    </CssVarsProvider>
  );

const ORG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_DISPUTE_ID = 'cccccccccccccccccccccccc';

const dispute = (over: Partial<StripeDisputeRow> = {}): StripeDisputeRow => ({
  id: ORG_ID,
  stripeDisputeId: 'dp_org',
  chargeId: 'ch_1',
  paymentIntentId: null,
  amount: 2500,
  currency: 'usd',
  reason: 'product_not_received',
  stripeStatus: 'needs_response',
  subject: 'organization',
  subjectId: 'dddddddddddddddddddddddd',
  state: 'open',
  openedAt: '2026-10-30T10:00:00.000Z',
  closedAt: null,
  resolution: null,
  contain: null,
  ...over,
});

const containedUserDispute = (over: Partial<StripeDisputeRow> = {}): StripeDisputeRow =>
  dispute({
    id: USER_DISPUTE_ID,
    stripeDisputeId: 'dp_user',
    subject: 'user',
    subjectId: USER_ID,
    stripeStatus: 'lost',
    state: 'resolved',
    closedAt: '2026-10-31T10:00:00.000Z',
    resolution: { outcome: 'lost', resolvedBy: null, note: null, resolvedAt: '2026-10-31T10:00:00.000Z' },
    contain: {
      batchId: 'batch-1',
      containedAt: '2026-10-31T10:00:00.000Z',
      suspended: true,
      creditDelta: -400,
      apiKeysRevoked: 2,
      undoneAt: null,
      undoneBy: null,
    },
    ...over,
  });

const list = (over: Partial<StripeDisputeListResponse> = {}): StripeDisputeListResponse => ({
  data: [dispute(), containedUserDispute()],
  truncated: false,
  ...over,
});

const queryResult = (data: StripeDisputeListResponse) => ({ data, isPending: false, error: null, refetch: vi.fn() });

describe('StripeDisputesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.search = {};
    m.useStripeDisputes.mockReturnValue(queryResult(list()));
  });

  it('lists every dispute by default and renders the columns', () => {
    renderTab();
    expect(m.useStripeDisputes).toHaveBeenCalledWith({ state: undefined, subject: undefined });
    expect(within(screen.getByTestId('admin-page-header')).getByRole('heading').textContent).toBe('Disputes (2)');

    const orgRow = screen.getByTestId(`stripe-dispute-row-${ORG_ID}`);
    expect(within(orgRow).getByText('$25.00')).toBeTruthy();
    expect(within(orgRow).getByText('Product not received')).toBeTruthy();
    expect(screen.getByTestId(`stripe-dispute-state-${ORG_ID}`).textContent).toBe('Open');
    expect(screen.getByTestId(`stripe-dispute-status-${ORG_ID}`).getAttribute('data-tone')).toBe('warn');

    const userRow = screen.getByTestId(`stripe-dispute-row-${USER_DISPUTE_ID}`);
    expect(screen.getByTestId(`stripe-dispute-user-link-${USER_DISPUTE_ID}`).getAttribute('href')).toBe(
      `/admin/users/${USER_ID}`
    );
    expect(screen.getByTestId(`stripe-dispute-status-${USER_DISPUTE_ID}`).getAttribute('data-tone')).toBe('bad');
    expect(within(userRow).getAllByText('Lost')).toHaveLength(2);
    expect(screen.getByTestId(`stripe-dispute-contain-${USER_DISPUTE_ID}`).textContent).toBe('Contained');
  });

  it('labels an unmatched dispute "No match" and a resolved-by-admin outcome', () => {
    m.useStripeDisputes.mockReturnValue(
      queryResult(
        list({
          data: [
            dispute({
              subject: 'unmatched',
              subjectId: null,
              state: 'resolved',
              resolution: { outcome: 'admin', resolvedBy: 'u', note: null, resolvedAt: '2026-10-31T10:00:00.000Z' },
            }),
          ],
        })
      )
    );
    renderTab();
    expect(screen.getByTestId(`stripe-dispute-subject-${ORG_ID}`).textContent).toBe('No match');
    expect(screen.getByText('Resolved by admin')).toBeTruthy();
  });

  it('reads the filters from the URL', () => {
    m.search = { disputeState: 'open', disputeSubject: 'unmatched' };
    renderTab();
    expect(m.useStripeDisputes).toHaveBeenCalledWith({ state: 'open', subject: 'unmatched' });
  });

  it('offers Resolve only on open organization or unmatched disputes', () => {
    renderTab();
    expect(screen.getByTestId(`stripe-dispute-resolve-btn-${ORG_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`stripe-dispute-resolve-btn-${USER_DISPUTE_ID}`)).toBeNull();
  });

  it('offers Undo contain only while the containment is not undone', () => {
    m.useStripeDisputes.mockReturnValue(
      queryResult(
        list({
          data: [
            containedUserDispute(),
            containedUserDispute({
              id: ORG_ID,
              contain: {
                batchId: 'b',
                containedAt: '2026-10-31T10:00:00.000Z',
                suspended: true,
                creditDelta: 0,
                apiKeysRevoked: 0,
                undoneAt: '2026-11-01T10:00:00.000Z',
                undoneBy: 'u',
              },
            }),
          ],
        })
      )
    );
    renderTab();
    expect(screen.getByTestId(`stripe-dispute-undo-btn-${USER_DISPUTE_ID}`)).toBeTruthy();
    expect(screen.queryByTestId(`stripe-dispute-undo-btn-${ORG_ID}`)).toBeNull();
    expect(screen.getByTestId(`stripe-dispute-contain-${ORG_ID}`).textContent).toBe('Undone');
  });

  it('resolves a dispute with a reason and closes the dialog', async () => {
    m.resolve.mockResolvedValue({ status: 'done', item: dispute({ state: 'resolved' }) });
    renderTab();
    fireEvent.click(screen.getByTestId(`stripe-dispute-resolve-btn-${ORG_ID}`));
    const dialog = await screen.findByTestId('stripe-dispute-resolve-dialog');
    expect(within(dialog).getByText(/does not change any account, flag or credits/)).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-resolve-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-resolve-dialog-confirm-btn'));

    await waitFor(() => expect(m.resolve).toHaveBeenCalledWith({ id: ORG_ID, reason: 'Handled in Stripe' }));
    await waitFor(() => expect(screen.queryByTestId('stripe-dispute-resolve-dialog')).toBeNull());
  });

  it('keeps the resolve dialog open with the server message on a conflict', async () => {
    m.resolve.mockResolvedValue({
      status: 'conflict',
      item: dispute({ state: 'resolved' }),
      message: 'Already resolved.',
    });
    renderTab();
    fireEvent.click(screen.getByTestId(`stripe-dispute-resolve-btn-${ORG_ID}`));
    const dialog = await screen.findByTestId('stripe-dispute-resolve-dialog');
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-resolve-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-resolve-dialog-confirm-btn'));

    expect((await screen.findByTestId('stripe-dispute-resolve-conflict')).textContent).toContain('Already resolved.');
    expect(screen.getByTestId('stripe-dispute-resolve-dialog')).toBeTruthy();
    // The swapped-in row is resolved, so the dialog no longer offers to resolve it.
    expect(
      (within(dialog).getByTestId('stripe-dispute-resolve-dialog-confirm-btn') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('previews what Undo contain restores and submits it', async () => {
    m.undo.mockResolvedValue({ status: 'done', item: containedUserDispute() });
    renderTab();
    fireEvent.click(screen.getByTestId(`stripe-dispute-undo-btn-${USER_DISPUTE_ID}`));
    const dialog = await screen.findByTestId('stripe-dispute-undo-dialog');
    const preview = within(dialog).getByTestId('stripe-dispute-undo-preview').textContent ?? '';
    expect(preview).toContain('unsuspended');
    expect(preview).toContain('400 credits');
    expect(preview).toContain('2 API keys');
    expect(dialog.textContent).toContain('remains blocked until the flag is cleared');

    fireEvent.click(within(dialog).getByTestId('stripe-dispute-undo-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-undo-dialog-confirm-btn'));
    await waitFor(() =>
      expect(m.undo).toHaveBeenCalledWith({ id: USER_DISPUTE_ID, reason: 'Customer verified as legitimate' })
    );
  });

  it('shows a conflict without an item on undo', async () => {
    m.undo.mockResolvedValue({ status: 'conflict', item: null, message: 'A later bulk action changed the user.' });
    renderTab();
    fireEvent.click(screen.getByTestId(`stripe-dispute-undo-btn-${USER_DISPUTE_ID}`));
    const dialog = await screen.findByTestId('stripe-dispute-undo-dialog');
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-undo-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('stripe-dispute-undo-dialog-confirm-btn'));
    expect((await screen.findByTestId('stripe-dispute-undo-conflict')).textContent).toContain('later bulk action');
  });

  it('shows the truncated notice and leaves the partial count out of the header', () => {
    m.useStripeDisputes.mockReturnValue(queryResult(list({ truncated: true })));
    renderTab();
    expect(screen.getByTestId('stripe-dispute-truncated')).toBeTruthy();
    expect(within(screen.getByTestId('admin-page-header')).getByRole('heading').textContent).toBe('Disputes');
  });

  it('shows the empty state and refreshes', () => {
    const query = queryResult(list({ data: [] }));
    m.useStripeDisputes.mockReturnValue(query);
    renderTab();
    expect(screen.getByText('No disputes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('stripe-dispute-reset-btn'));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('clears the filters from a filtered empty state', async () => {
    m.search = { disputeState: 'open' };
    m.useStripeDisputes.mockReturnValue(queryResult(list({ data: [] })));
    renderTab();
    expect(screen.getByText('No disputes match these filters')).toBeTruthy();
    fireEvent.click(screen.getByTestId('stripe-dispute-reset-btn'));
    await waitFor(() => expect(m.navigate).toHaveBeenCalled());
  });

  it('shows the load error with a retry', () => {
    const query = { ...queryResult(list()), data: undefined, error: new Error('boom') };
    m.useStripeDisputes.mockReturnValue(query);
    renderTab();
    expect(within(screen.getByTestId('admin-error-state')).getByText("Couldn't load disputes.")).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});

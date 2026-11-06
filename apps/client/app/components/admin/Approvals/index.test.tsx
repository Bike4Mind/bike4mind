import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockApprove, mockReject, mockNextPage, mockBulkResult, rows, queryFlags } = vi.hoisted(() => ({
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockNextPage: vi.fn(),
  mockBulkResult: vi.fn(),
  queryFlags: { hasNextPage: false },
  rows: [] as unknown[],
}));

vi.mock('../Users/List/useUsersBulkResult', () => ({ useUsersBulkResult: () => mockBulkResult }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'me' } }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useLoginAsUser: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@client/app/hooks/data/adminApprovals', () => ({
  useAdminApprovals: () => ({
    data: rows,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    hasNextPage: queryFlags.hasNextPage,
    fetchNextPage: mockNextPage,
  }),
  useApproveAdminApproval: () => ({ mutateAsync: mockApprove, isPending: false }),
  useRejectAdminApproval: () => ({ mutateAsync: mockReject, isPending: false }),
}));

import Approvals from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderQueue = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <Approvals />
    </CssVarsProvider>
  );

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  action: 'users.bulk',
  summary: `suspend 30 users (${id})`,
  reason: 'Spam wave',
  status: 'pending',
  requestedBy: { id: 'other', name: 'Other Admin', email: 'o@example.com' },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  params: {},
  stalled: false,
  canDecide: true,
  ...overrides,
});

describe('Approvals queue', () => {
  beforeEach(() => {
    rows.length = 0;
    queryFlags.hasNextPage = false;
    mockNextPage.mockReset();
    mockBulkResult.mockReset();
    mockApprove.mockReset().mockResolvedValue({});
    mockReject.mockReset().mockResolvedValue({});
  });

  it('lists requests and approves one another admin made', async () => {
    rows.push(row('a1'));
    renderQueue();

    expect(screen.getByTestId('admin-approvals-queue')).toBeTruthy();
    expect(screen.getByTestId('admin-approval-row-a1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-approve-btn'));
    expect(mockApprove).toHaveBeenCalledWith('a1');
  });

  it('disables approve on your own request and offers withdraw instead', () => {
    rows.push(row('own', { requestedBy: { id: 'me', name: 'Me', email: 'me@example.com' }, canDecide: false }));
    renderQueue();

    expect((screen.getByTestId('admin-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('admin-reject-btn').textContent).toBe('Withdraw');
  });

  it('asks for a reason before rejecting', () => {
    rows.push(row('a2'));
    renderQueue();

    fireEvent.click(screen.getByTestId('admin-reject-btn'));
    expect(screen.getByTestId('admin-approval-reject-dialog-confirm-btn')).toHaveProperty('disabled', true);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it('offers the requester the start button on an approved impersonation', () => {
    rows.push(
      row('imp', {
        action: 'user.impersonate_admin',
        status: 'approved',
        requestedBy: { id: 'me', name: 'Me', email: 'me@example.com' },
        params: { targetUserId: 't1' },
        canDecide: false,
      })
    );
    renderQueue();

    expect(screen.getByTestId('admin-approval-start-impersonation-btn')).toBeTruthy();
    expect(screen.queryByTestId('admin-approve-btn')).toBeNull();
  });

  it('shows the action label for a row whose summary and reason are withheld', () => {
    rows.push(row('hidden', { action: 'user.impersonate_admin', summary: null, reason: null, canDecide: false }));
    renderQueue();

    const rendered = screen.getByTestId('admin-approval-row-hidden').textContent ?? '';
    expect(rendered).toContain('Impersonate an admin');
    expect(rendered).not.toContain('null');
  });

  it('shows the sorted user ids of a bulk request in the details dialog', () => {
    rows.push(
      row('bulk', { params: { action: { type: 'suspend' }, target: { kind: 'ids', userIds: ['u-b', 'u-a'] } } })
    );
    rows.push(row('bare', { params: null }));
    renderQueue();

    expect(screen.getAllByTestId('admin-approval-details-btn')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('admin-approval-details-btn'));
    const list = screen.getByTestId('admin-approval-details-user-ids');
    expect(Array.from(list.querySelectorAll('li')).map(li => li.textContent)).toEqual(['u-a', 'u-b']);
  });
  it('offers the next page when the server returned a cursor', () => {
    queryFlags.hasNextPage = true;
    renderQueue();
    fireEvent.click(screen.getByTestId('admin-approvals-load-more-btn'));
    expect(mockNextPage).toHaveBeenCalledOnce();
  });

  it('passes partial bulk outcomes to the shared warning and undo flow and retains their details', async () => {
    const result = {
      batchId: 'batch',
      applied: 1,
      skipped: 0,
      failed: [],
      partial: true,
      remaining: 2,
      undoExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      blockedDomains: [],
      canceledSubscriptions: 0,
      subscriptionCancelFailures: [{ userId: 'u-a', error: 'cancel failed' }],
    };
    rows.push(row('partial', { params: { target: { userIds: ['u-a'] } } }));
    mockApprove.mockResolvedValue({ approval: { id: 'partial', status: 'executed' }, result });
    renderQueue();
    fireEvent.click(screen.getByTestId('admin-approve-btn'));
    await waitFor(() => expect(mockBulkResult).toHaveBeenCalledWith(result));
    expect(screen.getByTestId('admin-approval-details-result').textContent).toContain('cancel failed');
    expect(screen.getByTestId('admin-approval-details-result').textContent).toContain('"remaining": 2');
  });
});

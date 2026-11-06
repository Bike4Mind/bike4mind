import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockApprove, mockReject, rows } = vi.hoisted(() => ({
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  rows: [] as unknown[],
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'me' } }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useLoginAsUser: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@client/app/hooks/data/adminApprovals', () => ({
  useAdminApprovals: () => ({ data: rows, isLoading: false, error: null, refetch: vi.fn() }),
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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuditEntry } from '@bike4mind/common';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('../actions/useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));

import { AdminLogTab } from './AdminLogTab';

const suspended = makeAuditEntry({
  id: 'suspend',
  action: 'user.profile.updated',
  summary: 'updated isBanned',
  reason: 'Chargeback',
  occurredAt: new Date('2026-10-20T09:00:00Z'),
  changes: [{ field: 'isBanned', before: false, after: true }],
});
const tagged = makeAuditEntry({
  id: 'tags',
  action: 'user.profile.updated',
  summary: 'updated tags',
  occurredAt: new Date('2026-10-19T09:00:00Z'),
  changes: [{ field: 'tags', before: [], after: ['vip'] }],
});
const credits = makeAuditEntry({
  id: 'credits',
  action: 'user.credits.adjusted',
  occurredAt: new Date('2026-10-18T09:00:00Z'),
  changes: [{ field: 'currentCredits', before: 5410, after: 7410 }],
});
const signIn = makeAuditEntry({ id: 'auth', source: 'auth', action: 'auth.login_success' });

const respond = (entries: AuditEntry[]) => mocks.get.mockResolvedValue({ data: { entries, nextCursor: null } });

const renderTab = (user: AdminUserProfile) => render(<AdminLogTab user={user} />, { wrapper: ProfileTestWrapper });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
});

describe('AdminLogTab', () => {
  it('lists only admin entries with the action, before and after, reason and actor', async () => {
    respond([suspended, tagged, credits, signIn]);
    renderTab(buildProfile({ isBanned: true, tags: ['vip'] }));

    const rows = await screen.findAllByTestId('user-admin-log-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Suspended account');
    expect(rows[0]).toHaveTextContent('Reason: Chargeback');
    expect(within(rows[0]).getByTestId('user-admin-log-actor')).toHaveTextContent('Alice Admin');
    expect(within(rows[1]).getByTestId('user-admin-log-changes')).toHaveTextContent('Tags: None \u2192 vip');
    expect(rows[2]).toHaveTextContent('Credits +2,000 (5,410 to 7,410)');
  });

  it('offers Undo only where the change still stands and has no own flow', async () => {
    respond([suspended, tagged, credits]);
    renderTab(buildProfile({ isBanned: true, tags: [] }));

    const rows = await screen.findAllByTestId('user-admin-log-row');
    expect(within(rows[0]).getByTestId('user-admin-log-undo-btn')).toBeInTheDocument();
    // Tags were changed again since, and credits have their own adjust flow.
    expect(within(rows[1]).queryByTestId('user-admin-log-undo-btn')).not.toBeInTheDocument();
    expect(within(rows[2]).queryByTestId('user-admin-log-undo-btn')).not.toBeInTheDocument();
  });

  it('undoes through the audited update and offers to redo', async () => {
    respond([suspended]);
    renderTab(buildProfile({ isBanned: true }));

    fireEvent.click(await screen.findByTestId('user-admin-log-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ isBanned: false, statusChangeReason: 'Undo: Chargeback' })
    );
    expect(await screen.findByText('Undone: Suspended account')).toBeInTheDocument();
  });

  it('opens the full audit entry from a row', async () => {
    respond([suspended]);
    renderTab(buildProfile({ isBanned: true }));

    fireEvent.click(await screen.findByTestId('user-admin-log-row-open-btn'));
    expect(await screen.findByTestId('audit-drawer')).toBeInTheDocument();
  });

  it('explains an empty log', async () => {
    respond([signIn]);
    renderTab(buildProfile());
    expect(await screen.findByText('No admin changes yet')).toBeInTheDocument();
    expect(screen.getByText('Changes admins make to this account appear here.')).toBeInTheDocument();
  });

  it('does not claim the log is empty while older pages are unloaded', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [signIn], nextCursor: 'older' } });
    renderTab(buildProfile());
    expect(await screen.findByText(/Load more to check older entries\./)).toBeInTheDocument();
    expect(screen.queryByText('Changes admins make to this account appear here.')).not.toBeInTheDocument();
  });

  it('keeps Undo available and shows no toast when the update rejects', async () => {
    mocks.update.mockRejectedValue(new Error('boom'));
    respond([suspended]);
    renderTab(buildProfile({ isBanned: true }));

    fireEvent.click(await screen.findByTestId('user-admin-log-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ isBanned: false, statusChangeReason: 'Undo: Chargeback' })
    );
    await waitFor(() => expect(screen.getByTestId('user-admin-log-undo-btn')).not.toBeDisabled());
    expect(screen.queryByText('Undone: Suspended account')).not.toBeInTheDocument();
  });

  it('shows a retryable error when the log cannot be loaded', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    renderTab(buildProfile());
    expect(await screen.findByText('The admin log could not be loaded.')).toBeInTheDocument();

    respond([suspended]);
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('user-admin-log-row')).toBeInTheDocument();
  });
});

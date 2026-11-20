import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUser } from '@client/app/contexts/UserContext';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { truncateUserId } from './Users/UserIdChip';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: m.get, post: m.post } }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));

import EmailVerificationTab from './EmailVerificationTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const VERIFIED_ID = '6900781a8c1b76a684f80001';
const UNVERIFIED_ID = '6900781a8c1b76a684f80002';
const CHANGING_ID = '6900781a8c1b76a684f80003';
const SECOND_UNVERIFIED_ID = '6900781a8c1b76a684f80004';

const user = (overrides: Record<string, unknown>) => ({
  username: 'someone',
  email: 'someone@example.com',
  name: 'Some One',
  emailVerified: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const USERS = [
  user({
    _id: VERIFIED_ID,
    username: 'verified-user',
    email: 'a-very-long-address-that-would-crush-its-column@example.com',
    emailVerified: true,
    emailVerifiedAt: '2026-10-02T00:00:00.000Z',
  }),
  user({
    _id: UNVERIFIED_ID,
    username: 'unverified-user',
    email: 'unverified@example.com',
    emailVerificationSentAt: '2026-10-03T00:00:00.000Z',
    emailVerificationExpires: '2099-01-01T00:00:00.000Z',
  }),
  user({ _id: CHANGING_ID, username: 'changing-user', emailVerified: true, pendingEmail: 'next@example.com' }),
];

const listResponse = (users = USERS, totalCount = 120) => ({
  data: { users, pagination: { page: 1, limit: 25, totalPages: Math.ceil(totalCount / 25), totalCount } },
});

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <EmailVerificationTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

// The username renders once the list has loaded, in the table or any earlier layout of the tab.
const listLoaded = () => screen.findAllByText('verified-user');

const openRowMenu = async (id: string) => {
  fireEvent.click(await screen.findByTestId(`email-verification-row-actions-${id}`));
};

const LIST_URL = '/api/admin/users/email-verification';

describe('EmailVerificationTab', () => {
  beforeEach(() => {
    useUser.setState({ currentUser: { id: 'admin-1', isAdmin: true } as never });
    vi.clearAllMocks();
    m.get.mockResolvedValue(listResponse());
    m.post.mockResolvedValue({ data: { success: true } });
  });

  it('opens with the page header and the server total as its count', async () => {
    renderTab();

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Email verification (120)')
    );
  });

  it('has exactly one pager, the table footer, driven by the server total', async () => {
    renderTab();

    await listLoaded();
    expect(screen.getAllByTestId('admin-table-footer')).toHaveLength(1);
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 3 of 120');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('requests the next page and a new page size through the footer', async () => {
    renderTab();
    await listLoaded();

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ page: 2, limit: 25 }),
      })
    );

    fireEvent.click(within(screen.getByTestId('admin-table-page-size')).getByRole('combobox'));
    fireEvent.click(await screen.findByTestId('admin-table-page-size-50'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ page: 1, limit: 50 }),
      })
    );
  });

  it('filters by status from a filter chip and returns to the first page', async () => {
    renderTab();
    await listLoaded();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ page: 2 }),
      })
    );

    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-status-pending'));

    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ status: 'pending', page: 1 }),
      })
    );
  });

  // The status chip is single-select: picking the chosen status again keeps it, and its clear button is
  // the way back to every status.
  it('keeps a re-picked status, and returns to every status when the chip is cleared', async () => {
    renderTab();
    await listLoaded();
    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-status-pending'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith(LIST_URL, { params: expect.objectContaining({ status: 'pending' }) })
    );

    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-status-pending'));
    expect(screen.getByTestId('admin-filter-status')).toHaveTextContent('Status: Pending verification');

    fireEvent.click(screen.getByTestId('admin-filter-clear-status-btn'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith(LIST_URL, { params: expect.objectContaining({ status: 'all', page: 1 }) })
    );
    expect(screen.getByTestId('admin-filter-status')).toHaveTextContent(/^Status$/);
  });

  it('keeps unverify out of the rows, behind each row menu, with no danger confirm on the page', async () => {
    renderTab();
    await listLoaded();

    // hidden: true also counts controls CSS hides, so no Unverify button can sit out of view in a row.
    expect(screen.queryAllByRole('button', { name: /unverify/i, hidden: true })).toHaveLength(0);
    // The danger tone belongs to the unverify dialog's confirm, which only a row menu opens.
    expect(document.body.querySelector('[data-tone="danger"]')).toBeNull();
    expect(screen.getByTestId(`email-verification-row-actions-${VERIFIED_ID}`)).toBeInTheDocument();
  });

  it('shows a status chip per state', async () => {
    renderTab();

    expect(await screen.findByTestId(`email-verification-status-${VERIFIED_ID}`)).toHaveTextContent('Verified');
    expect(screen.getByTestId(`email-verification-status-${VERIFIED_ID}`)).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId(`email-verification-status-${UNVERIFIED_ID}`)).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId(`email-verification-status-${CHANGING_ID}`)).toHaveAttribute('data-tone', 'info');
  });

  it('truncates user ids with a copy chip and keeps a long email on one line', async () => {
    renderTab();
    await listLoaded();

    const [chip] = screen.getAllByTestId('admin-user-id-chip');
    const row = screen.getByTestId(`email-verification-row-${VERIFIED_ID}`);
    expect(chip).toHaveTextContent(truncateUserId(VERIFIED_ID));
    expect(chip).not.toHaveTextContent(VERIFIED_ID);
    expect(within(row).getByTitle(/a-very-long-address/)).toHaveStyle({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });

  it('scrolls the table sideways inside its own container instead of crushing columns', async () => {
    renderTab();
    await listLoaded();

    expect(screen.getByRole('region', { name: 'Email verification' })).toHaveStyle({ overflowX: 'auto' });
    expect(screen.getByTestId('email-verification-table')).toHaveStyle({ minWidth: '62rem' });
  });

  it('unverifies through the action dialog and posts the picked reason', async () => {
    renderTab();

    await openRowMenu(VERIFIED_ID);
    fireEvent.click(await screen.findByTestId(`email-verification-row-unverify-${VERIFIED_ID}`));

    expect(await screen.findByTestId('email-unverify-dialog')).toHaveTextContent('verified-user');
    expect(screen.getByTestId('email-unverify-dialog')).toHaveTextContent('Bounced or invalid address');
    const confirm = screen.getByTestId('email-unverify-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    // Solid danger is reserved for this final confirm.
    expect(confirm).toHaveAttribute('data-tone', 'danger');
    expect(m.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('email-unverify-dialog-reason-input-preset-1'));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(m.post).toHaveBeenCalledWith(`/api/admin/users/${VERIFIED_ID}/unverify-email`, {
        reason: ADMIN_REASON_PRESETS.emailVerification[1],
      })
    );
    await waitFor(() => expect(screen.queryByTestId('email-unverify-dialog')).toBeNull());
    expect(m.toastSuccess).toHaveBeenCalledWith('Email unverified for verified-user');
  });

  it('verifies through the action dialog and posts the picked reason', async () => {
    renderTab();

    await openRowMenu(UNVERIFIED_ID);
    fireEvent.click(await screen.findByTestId(`email-verification-row-verify-${UNVERIFIED_ID}`));
    const verifyDialog = await screen.findByTestId('email-verify-dialog');
    // Bounces are a reason to unverify, not to verify, so the verify dialog gets its own presets.
    expect(verifyDialog).not.toHaveTextContent('Bounced or invalid address');
    expect(verifyDialog).toHaveTextContent('Ownership confirmed by support');
    fireEvent.click(await screen.findByTestId('email-verify-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('email-verify-dialog-confirm-btn')).toHaveAttribute('data-tone', 'neutral');
    fireEvent.click(screen.getByTestId('email-verify-dialog-confirm-btn'));

    await waitFor(() =>
      expect(m.post).toHaveBeenCalledWith(`/api/admin/users/${UNVERIFIED_ID}/verify-email`, {
        reason: ADMIN_REASON_PRESETS.emailManualVerify[0],
      })
    );
  });

  it('resends a verification email straight from the row menu, with a toast', async () => {
    renderTab();

    await openRowMenu(UNVERIFIED_ID);
    fireEvent.click(await screen.findByTestId(`email-verification-row-resend-${UNVERIFIED_ID}`));

    await waitFor(() => expect(m.post).toHaveBeenCalledWith(`/api/admin/users/${UNVERIFIED_ID}/resend-verification`));
    await waitFor(() =>
      expect(m.toastSuccess).toHaveBeenCalledWith('Verification email resent to unverified@example.com')
    );
  });

  it('offers only the email change link while an address change is pending', async () => {
    renderTab();

    await openRowMenu(CHANGING_ID);
    const resendChange = await screen.findByTestId(`email-verification-row-resend-email-change-${CHANGING_ID}`);
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(resendChange);

    await waitFor(() => expect(m.post).toHaveBeenCalledWith(`/api/admin/users/${CHANGING_ID}/resend-email-change`));
  });

  it.each([
    ['resend', UNVERIFIED_ID, 'Sending verification email', 'Verification email resent to unverified@example.com'],
    ['resend-email-change', CHANGING_ID, 'Sending email change link', 'Email change link resent to next@example.com'],
  ])('ignores a second %s on a row while its first one is still sending', async (command, id, pendingLabel, toast) => {
    let finishSend: (value: unknown) => void = () => undefined;
    m.post.mockImplementation(() => new Promise(resolve => (finishSend = resolve)));
    renderTab();

    await openRowMenu(id);
    fireEvent.click(await screen.findByTestId(`email-verification-row-${command}-${id}`));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId(`email-verification-row-${command}-${id}`)).toBeNull());

    await openRowMenu(id);
    const again = await screen.findByTestId(`email-verification-row-${command}-${id}`);
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).toHaveTextContent(pendingLabel);
    fireEvent.click(again);
    expect(m.post).toHaveBeenCalledTimes(1);

    await act(async () => finishSend({ data: { success: true } }));
    await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledWith(toast));
  });

  it('guards each row on its own while two rows resend at once', async () => {
    m.get.mockResolvedValue(
      listResponse([
        ...USERS,
        user({
          _id: SECOND_UNVERIFIED_ID,
          username: 'second-user',
          email: 'second@example.com',
          emailVerificationSentAt: '2026-10-03T00:00:00.000Z',
          emailVerificationExpires: '2099-01-01T00:00:00.000Z',
        }),
      ])
    );
    const finishSend = new Map<string, (value: unknown) => void>();
    m.post.mockImplementation((url: string) => new Promise(resolve => finishSend.set(url, resolve)));
    const resendUrl = (id: string) => `/api/admin/users/${id}/resend-verification`;
    const resendItem = (id: string) => `email-verification-row-resend-${id}`;
    const toggleMenu = (id: string) => fireEvent.click(screen.getByTestId(`email-verification-row-actions-${id}`));
    const expectResend = async (id: string, sending: boolean) => {
      toggleMenu(id);
      const item = await screen.findByTestId(resendItem(id));
      expect(item.getAttribute('aria-disabled') === 'true', id).toBe(sending);
      expect(item, id).toHaveTextContent(sending ? 'Sending verification email' : 'Resend verification email');
      toggleMenu(id);
      await waitFor(() => expect(screen.queryByTestId(resendItem(id))).toBeNull());
    };
    renderTab();
    await listLoaded();

    for (const id of [UNVERIFIED_ID, SECOND_UNVERIFIED_ID]) {
      toggleMenu(id);
      fireEvent.click(await screen.findByTestId(resendItem(id)));
      await waitFor(() => expect(screen.queryByTestId(resendItem(id))).toBeNull());
    }
    expect(m.post.mock.calls.map(([url]) => url)).toEqual([resendUrl(UNVERIFIED_ID), resendUrl(SECOND_UNVERIFIED_ID)]);
    await expectResend(UNVERIFIED_ID, true);
    await expectResend(SECOND_UNVERIFIED_ID, true);

    await act(async () => finishSend.get(resendUrl(UNVERIFIED_ID))?.({ data: { success: true } }));
    await waitFor(() =>
      expect(m.toastSuccess).toHaveBeenCalledWith('Verification email resent to unverified@example.com')
    );
    await expectResend(UNVERIFIED_ID, false);
    await expectResend(SECOND_UNVERIFIED_ID, true);

    await act(async () => finishSend.get(resendUrl(SECOND_UNVERIFIED_ID))?.({ data: { success: true } }));
    await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledWith('Verification email resent to second@example.com'));
    await expectResend(SECOND_UNVERIFIED_ID, false);
  });

  it('searches through the filter bar and returns to the first page', async () => {
    renderTab();
    await listLoaded();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ page: 2 }),
      })
    );

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'carol' } });

    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ search: 'carol', page: 1 }),
      })
    );
  });

  it('reports the server error from a failed resend', async () => {
    m.post.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: 'Verification link was sent too recently', message: 'Bad Request' },
        },
      })
    );
    renderTab();

    await openRowMenu(UNVERIFIED_ID);
    fireEvent.click(await screen.findByTestId(`email-verification-row-resend-${UNVERIFIED_ID}`));

    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('Verification link was sent too recently'));

    await openRowMenu(UNVERIFIED_ID);
    const retry = await screen.findByTestId(`email-verification-row-resend-${UNVERIFIED_ID}`);
    expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveTextContent('Resend verification email');
  });

  it('reports a failed unverify, closes the dialog and refetches the list', async () => {
    m.post.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'Nope', message: 'Bad Request' } },
      })
    );
    renderTab();

    await openRowMenu(VERIFIED_ID);
    fireEvent.click(await screen.findByTestId(`email-verification-row-unverify-${VERIFIED_ID}`));
    fireEvent.click(await screen.findByTestId('email-unverify-dialog-reason-input-preset-0'));
    const getsBefore = m.get.mock.calls.length;
    fireEvent.click(screen.getByTestId('email-unverify-dialog-confirm-btn'));

    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('Nope'));
    await waitFor(() => expect(screen.queryByTestId('email-unverify-dialog')).toBeNull());
    expect(m.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(m.get.mock.calls.length).toBeGreaterThan(getsBefore));
  });

  it('shows a retry in place of the rows when the list fails', async () => {
    m.get.mockRejectedValueOnce(new Error('Network down')).mockResolvedValue(listResponse());
    renderTab();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Network down');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));

    expect(await screen.findByTestId(`email-verification-row-${VERIFIED_ID}`)).toBeInTheDocument();
  });

  it('offers to clear the filters when they match nothing', async () => {
    renderTab();
    await listLoaded();
    m.get.mockResolvedValue(listResponse([], 0));

    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(await screen.findByTestId('admin-filter-status-verified'));

    expect(await screen.findByText('No accounts match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('email-verification-empty-clear-btn'));

    await waitFor(() =>
      expect(m.get).toHaveBeenLastCalledWith('/api/admin/users/email-verification', {
        params: expect.objectContaining({ status: 'all', page: 1 }),
      })
    );
  });
});

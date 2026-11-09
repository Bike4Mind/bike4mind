import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Every layout, old or new, renders the username once the list has loaded.
const listLoaded = () => screen.findAllByText('verified-user');

const openRowMenu = async (id: string) => {
  fireEvent.click(await screen.findByTestId(`email-verification-row-actions-${id}`));
};

describe('EmailVerificationTab', () => {
  beforeEach(() => {
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

  it('keeps unverify out of the rows, behind each row menu, with nothing danger-colored on the page', async () => {
    renderTab();
    await listLoaded();

    // hidden: true also counts controls a responsive breakpoint hides from jsdom.
    expect(screen.queryAllByRole('button', { name: /unverify/i, hidden: true })).toHaveLength(0);
    // Joy's stable color utility class, the only DOM trace of color="danger".
    expect(document.body.querySelector('[class*="colorDanger"]')).toBeNull();
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
    const confirm = screen.getByTestId('email-unverify-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    // Solid danger is reserved for this final confirm; Joy marks it with its color utility class.
    expect(confirm.className).toMatch(/colorDanger/);
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
    fireEvent.click(await screen.findByTestId('email-verify-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('email-verify-dialog-confirm-btn').className).not.toMatch(/colorDanger/);
    fireEvent.click(screen.getByTestId('email-verify-dialog-confirm-btn'));

    await waitFor(() =>
      expect(m.post).toHaveBeenCalledWith(`/api/admin/users/${UNVERIFIED_ID}/verify-email`, {
        reason: ADMIN_REASON_PRESETS.emailVerification[0],
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

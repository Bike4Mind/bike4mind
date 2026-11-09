import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { Button, Dropdown, IconButton, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { getErrorMessage, getServerErrorField } from '@client/app/utils/error';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  UpdatingBar,
  type AdminListState,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';
import UserIdChip from './Users/UserIdChip';

interface User {
  _id: string;
  username: string;
  email: string;
  name: string;
  emailVerified: boolean;
  emailVerifiedAt?: Date;
  emailVerificationSentAt?: Date;
  emailVerificationExpires?: Date;
  pendingEmail?: string;
  pendingEmailSentAt?: Date;
  pendingEmailExpires?: Date;
  createdAt: Date;
}

type VerificationStatusFilter = 'all' | 'verified' | 'unverified' | 'pending';

/** GET /api/admin/users/email-verification; `totalCount` drives the pager. */
interface EmailVerificationListResponse {
  users: User[];
  pagination: { page: number; limit: number; totalPages: number; totalCount: number };
}

const EMAIL_VERIFICATION_QUERY_KEY = ['admin', 'email-verification'] as const;

const useGetEmailVerificationUsers = (params: {
  page?: number;
  limit?: number;
  search?: string;
  status?: VerificationStatusFilter;
}) => {
  return useQuery({
    queryKey: [...EMAIL_VERIFICATION_QUERY_KEY, params],
    queryFn: async () => {
      const response = await api.get<EmailVerificationListResponse>('/api/admin/users/email-verification', {
        params,
      });
      return response.data;
    },
    // Keeps the current page on screen while the next one loads, so the pager never reads "0 of 0".
    placeholderData: keepPreviousData,
  });
};

const useResendVerification = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/resend-verification`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: EMAIL_VERIFICATION_QUERY_KEY });
    },
  });
};

const useResendEmailChange = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/resend-email-change`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: EMAIL_VERIFICATION_QUERY_KEY });
    },
  });
};

const useVerifyEmail = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, reason }: { userId: string; reason: string }) => {
      const response = await api.post(`/api/admin/users/${userId}/verify-email`, { reason });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: EMAIL_VERIFICATION_QUERY_KEY });
    },
  });
};

const useUnverifyEmail = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, reason }: { userId: string; reason: string }) => {
      const response = await api.post(`/api/admin/users/${userId}/unverify-email`, { reason });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: EMAIL_VERIFICATION_QUERY_KEY });
    },
  });
};

// The routes send their explanation in `error`, not `message`.
const errorText = (error: unknown) => getServerErrorField(error) ?? getErrorMessage(error);

const STATUS_FILTER_OPTIONS = [
  { value: 'verified', label: 'Verified' },
  { value: 'unverified', label: 'Unverified' },
  { value: 'pending', label: 'Pending verification' },
] as const satisfies readonly { value: Exclude<VerificationStatusFilter, 'all'>; label: string }[];

const toStatusFilter = (value: string | undefined): VerificationStatusFilter =>
  STATUS_FILTER_OPTIONS.find(option => option.value === value)?.value ?? 'all';

const EMPTY_VALUE = '\u2014';

const isExpired = (expiresAt?: Date) => !!expiresAt && new Date(expiresAt) < new Date();

const verificationStatus = (user: User): { tone: AdminStatusTone; label: string } => {
  if (user.pendingEmail) return { tone: 'info', label: 'Changing email' };
  if (user.emailVerified) return { tone: 'good', label: 'Verified' };
  if (user.emailVerificationSentAt) {
    return isExpired(user.emailVerificationExpires)
      ? { tone: 'bad', label: 'Expired' }
      : { tone: 'warn', label: 'Pending' };
  }
  return { tone: 'neutral', label: 'Not sent' };
};

const DateCell = ({ value, expired = false }: { value?: Date; expired?: boolean }) => {
  if (!value) return <Typography sx={{ color: 'admin.inkMuted' }}>{EMPTY_VALUE}</Typography>;
  const date = new Date(value);
  return (
    <Stack gap={0.25}>
      <Typography level="body-sm" noWrap>
        {expired ? 'Expired' : date.toLocaleDateString()}
      </Typography>
      <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
        {expired ? date.toLocaleDateString() : date.toLocaleTimeString()}
      </Typography>
    </Stack>
  );
};

const COLUMNS: DataColumn<User>[] = [
  {
    id: 'user',
    label: 'User',
    render: user => (
      <Stack gap={0.25} alignItems="flex-start" sx={{ minWidth: 0 }}>
        <Typography level="body-sm" fontWeight={500} noWrap title={user.username} sx={{ maxWidth: '100%' }}>
          {user.username}
        </Typography>
        {user.name && (
          <Typography level="body-xs" noWrap title={user.name} sx={{ color: 'admin.inkMuted', maxWidth: '100%' }}>
            {user.name}
          </Typography>
        )}
        <UserIdChip userId={user._id} />
      </Stack>
    ),
  },
  {
    id: 'email',
    label: 'Email',
    width: '14rem',
    render: user => (
      <Stack gap={0.25} sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap title={user.email}>
          {user.email}
        </Typography>
        {user.pendingEmail && (
          <Typography
            level="body-xs"
            noWrap
            title={`Changing to ${user.pendingEmail}`}
            sx={{ color: 'admin.inkMuted' }}
            data-testid={`email-verification-pending-email-${user._id}`}
          >
            {'\u2192'} {user.pendingEmail}
          </Typography>
        )}
      </Stack>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    width: '8rem',
    render: user => {
      const { tone, label } = verificationStatus(user);
      return <StatusChip tone={tone} label={label} data-testid={`email-verification-status-${user._id}`} />;
    },
  },
  { id: 'verifiedAt', label: 'Verified', width: '8.5rem', render: user => <DateCell value={user.emailVerifiedAt} /> },
  {
    id: 'lastSent',
    label: 'Last sent',
    width: '8.5rem',
    render: user => <DateCell value={user.emailVerificationSentAt} />,
  },
  {
    id: 'expires',
    label: 'Link expires',
    width: '8.5rem',
    render: user => (
      <DateCell value={user.emailVerificationExpires} expired={isExpired(user.emailVerificationExpires)} />
    ),
  },
];

type RowCommand = 'resend' | 'resend-email-change' | 'verify' | 'unverify';

const RowMenu = ({ user, onCommand }: { user: User; onCommand: (command: RowCommand, user: User) => void }) => {
  const item = (command: RowCommand, label: string) => (
    <MenuItem onClick={() => onCommand(command, user)} data-testid={`email-verification-row-${command}-${user._id}`}>
      {label}
    </MenuItem>
  );
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${user.username || user.email}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`email-verification-row-actions-${user._id}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        {/* While an address change is pending, its link is the only action offered. */}
        {user.pendingEmail && item('resend-email-change', 'Resend email change link')}
        {!user.pendingEmail && user.emailVerified && item('unverify', 'Unverify email')}
        {!user.pendingEmail && !user.emailVerified && item('resend', 'Resend verification email')}
        {!user.pendingEmail && !user.emailVerified && item('verify', 'Verify email')}
      </Menu>
    </Dropdown>
  );
};

const EmailVerificationTab = () => {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState<VerificationStatusFilter>('all');
  // Verify and unverify change the account, so they go through a dialog that asks for an audited reason.
  const [dialog, setDialog] = useState<{ type: 'verify' | 'unverify'; user: User } | null>(null);

  const queryClient = useQueryClient();
  const users = useGetEmailVerificationUsers({
    page: currentPage,
    limit: pageSize,
    search: debouncedSearch,
    status: statusFilter,
  });
  const resendVerification = useResendVerification();
  const resendEmailChange = useResendEmailChange();
  const verifyEmail = useVerifyEmail();
  const unverifyEmail = useUnverifyEmail();

  const rows = users.data?.users ?? [];
  const totalCount = users.data?.pagination.totalCount ?? 0;

  const filterState: AdminListState = {
    query: search,
    filters: { status: statusFilter === 'all' ? '' : statusFilter },
    view: '',
  };
  const changeFilters = (patch: Partial<AdminListState>) => {
    if (patch.query !== undefined) setSearch(patch.query);
    if (patch.filters) setStatusFilter(toStatusFilter(patch.filters.status));
    setCurrentPage(1);
  };
  const hasFilters = search.trim() !== '' || statusFilter !== 'all';
  const clearFilters = () => changeFilters({ query: '', filters: { status: '' } });

  // Refreshes the list after a failure too: the backend may have changed state on the way (an
  // expired token is cancelled, for one).
  const reportFailure = (error: unknown) => {
    toast.error(errorText(error));
    void queryClient.invalidateQueries({ queryKey: EMAIL_VERIFICATION_QUERY_KEY });
  };

  const runCommand = async (command: RowCommand, user: User) => {
    if (command === 'verify' || command === 'unverify') {
      setDialog({ type: command, user });
      return;
    }
    try {
      if (command === 'resend') {
        await resendVerification.mutateAsync(user._id);
        toast.success(`Verification email resent to ${user.email}`);
      } else {
        await resendEmailChange.mutateAsync(user._id);
        toast.success(`Email change link resent to ${user.pendingEmail}`);
      }
    } catch (error) {
      reportFailure(error);
    }
  };

  const confirmDialog = async (reason: string) => {
    if (!dialog) return;
    const { type, user } = dialog;
    try {
      if (type === 'verify') {
        await verifyEmail.mutateAsync({ userId: user._id, reason });
        toast.success(`Email verified for ${user.username}`);
      } else {
        await unverifyEmail.mutateAsync({ userId: user._id, reason });
        toast.success(`Email unverified for ${user.username}`);
      }
    } catch (error) {
      reportFailure(error);
    }
    setDialog(null);
  };

  const unverifying = dialog?.type === 'unverify';

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-email-verification-tab">
      <AdminPageHeader
        title="Email verification"
        count={users.data ? totalCount : undefined}
        description="Accounts by email verification state. Resend a link, or verify an address by hand."
        actions={
          <>
            <ContextHelpButton helpId="admin/email-verification" tooltipText="Email verification help" />
            <Button
              variant="plain"
              size="sm"
              startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
              disabled={users.isFetching}
              onClick={() => void users.refetch()}
              data-testid="email-verification-refresh-btn"
              sx={adminFocus}
            >
              Refresh
            </Button>
          </>
        }
      />

      <FilterBar
        state={filterState}
        filters={[{ id: 'status', label: 'Status', options: STATUS_FILTER_OPTIONS }]}
        onChange={changeFilters}
        searchLabel="Search by username, email or name"
      />

      <Stack gap={1} sx={{ minWidth: 0 }}>
        <UpdatingBar active={users.isFetching && !users.isPending} testId="email-verification-updating-bar" />
        <DataTable
          label="Email verification"
          testId="email-verification-table"
          rows={rows}
          columns={COLUMNS}
          getRowId={user => user._id}
          rowTestId={user => `email-verification-row-${user._id}`}
          loading={users.isPending}
          error={users.isError ? errorText(users.error) : undefined}
          onRetry={() => void users.refetch()}
          empty={
            hasFilters ? (
              <EmptyState
                title="No accounts match these filters"
                action={
                  <Button variant="outlined" onClick={clearFilters} data-testid="email-verification-empty-clear-btn">
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No accounts to show"
                action={
                  <Button
                    variant="outlined"
                    onClick={() => void users.refetch()}
                    data-testid="email-verification-empty-refresh-btn"
                  >
                    Refresh
                  </Button>
                }
              />
            )
          }
          pagination={{
            page: currentPage,
            pageSize,
            total: totalCount,
            onPageChange: setCurrentPage,
            onPageSizeChange: size => {
              setPageSize(size);
              setCurrentPage(1);
            },
          }}
          pageResetKey={`${statusFilter}:${debouncedSearch}`}
          rowActions={user => <RowMenu user={user} onCommand={(command, row) => void runCommand(command, row)} />}
          minWidth="62rem"
          maxHeight="none"
        />
      </Stack>

      <ActionDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={unverifying ? 'Unverify email' : 'Verify email'}
        description={
          dialog &&
          (unverifying ? (
            <>
              <strong>{dialog.user.username}</strong> ({dialog.user.email}) will have to verify this address again.
            </>
          ) : (
            <>
              Marks <strong>{dialog.user.email}</strong> as verified for {dialog.user.username} without the link being
              clicked.
            </>
          ))
        }
        reasonPresets={ADMIN_REASON_PRESETS.emailVerification}
        confirmLabel={unverifying ? 'Unverify email' : 'Verify email'}
        tone={unverifying ? 'danger' : 'neutral'}
        onConfirm={confirmDialog}
        data-testid={unverifying ? 'email-unverify-dialog' : 'email-verify-dialog'}
      />
    </Stack>
  );
};

export default EmailVerificationTab;

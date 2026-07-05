import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import {
  Badge,
  Button,
  Input,
  IconButton,
  LinearProgress,
  Sheet,
  Stack,
  Typography,
  Chip,
  Card,
  RadioGroup,
  Radio,
  FormControl,
  Select,
  Option,
  Box,
  Grid,
  Modal,
  ModalDialog,
  ModalClose,
} from '@mui/joy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import RefreshIcon from '@mui/icons-material/Refresh';
import EmailIcon from '@mui/icons-material/Email';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import WarningIcon from '@mui/icons-material/Warning';
import FilterListIcon from '@mui/icons-material/FilterList';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

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
  pendingEmailToken?: string;
  pendingEmailSentAt?: Date;
  pendingEmailExpires?: Date;
  createdAt: Date;
}

const useGetEmailVerificationUsers = (params: {
  page?: number;
  limit?: number;
  search?: string;
  status?: 'all' | 'verified' | 'unverified' | 'pending';
}) => {
  return useQuery({
    queryKey: ['admin', 'email-verification', params],
    queryFn: async () => {
      const response = await api.get('/api/admin/users/email-verification', { params });
      return response.data;
    },
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });
};

const useVerifyEmail = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/verify-email`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });
};

const useUnverifyEmail = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/unverify-email`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });
};

interface ConfirmModalState {
  open: boolean;
  type: 'resend' | 'verify' | 'unverify' | 'resend-email-change' | null;
  userId: string | null;
  email: string | null;
  username: string | null;
  pendingEmail?: string | null;
}

const PaginationControls = ({
  currentPage,
  totalPages,
  onPageChange,
  itemsPerPage,
  onItemsPerPageChange,
  totalCount,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemsPerPage: number;
  onItemsPerPageChange: (size: number) => void;
  totalCount: number;
}) => (
  <Stack
    direction="row"
    justifyContent="space-between"
    alignItems="center"
    sx={{ my: { xs: 0.5, sm: 1 } }}
    width="100%"
  >
    <Stack direction="row" spacing={{ xs: 1, sm: 2 }} justifyContent="center" alignItems="center">
      <Button size="sm" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>
        Previous
      </Button>
      <Typography level="body-xs" sx={{ display: { sm: 'none' } }}>
        {currentPage}/{totalPages}
      </Typography>
      <Typography level="title-sm" sx={{ display: { xs: 'none', sm: 'block' } }}>
        Page {currentPage} of {totalPages}
      </Typography>
      <Button size="sm" disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>
        Next
      </Button>
    </Stack>

    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      justifyContent="flex-end"
      sx={{ display: { xs: 'none', sm: 'flex' } }}
    >
      <FormControl>
        <RadioGroup
          orientation="horizontal"
          value={itemsPerPage}
          onChange={e => onItemsPerPageChange(Number(e.target.value))}
        >
          {[10, 20, 50].map(value => (
            <Radio key={value} value={value} label={`${value} per page`} size="sm" sx={{ mr: 2 }} />
          ))}
        </RadioGroup>
      </FormControl>
      <Typography level="title-sm" fontWeight={800}>
        Total Users: {totalCount}
      </Typography>
    </Stack>
  </Stack>
);

const getStatusChip = (user: User, isExpired: (d?: Date) => boolean) => {
  if (user.pendingEmail) {
    return (
      <Chip size="sm" color="primary">
        Changing
      </Chip>
    );
  }
  if (user.emailVerified) {
    return (
      <Chip size="sm" color="success">
        Verified
      </Chip>
    );
  }
  if (user.emailVerificationSentAt) {
    return (
      <Chip size="sm" color={isExpired(user.emailVerificationExpires) ? 'danger' : 'warning'}>
        {isExpired(user.emailVerificationExpires) ? 'Expired' : 'Pending'}
      </Chip>
    );
  }
  return (
    <Chip size="sm" color="neutral">
      Not Sent
    </Chip>
  );
};

const EmailVerificationRow = ({
  user,
  index,
  formatDate,
  isExpired,
  openConfirmModal,
  resendEmailChangePending,
  unverifyEmailPending,
  verifyEmailPending,
  resendVerificationPending,
}: {
  user: User;
  index: number;
  formatDate: (date?: Date) => string;
  isExpired: (expiresAt?: Date) => boolean;
  openConfirmModal: (
    type: 'resend' | 'verify' | 'unverify' | 'resend-email-change',
    userId: string,
    email: string,
    username: string,
    pendingEmail?: string
  ) => void;
  resendEmailChangePending: boolean;
  unverifyEmailPending: boolean;
  verifyEmailPending: boolean;
  resendVerificationPending: boolean;
}) => {
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const actionButtons = user.pendingEmail ? (
    <Button
      size="sm"
      color="primary"
      variant="soft"
      startDecorator={<EmailIcon />}
      onClick={() => openConfirmModal('resend-email-change', user._id, user.email, user.username, user.pendingEmail)}
      loading={resendEmailChangePending}
      disabled={resendEmailChangePending}
      sx={{ width: { xs: '100%', sm: 'auto' } }}
    >
      Resend
    </Button>
  ) : user.emailVerified ? (
    <Button
      size="sm"
      color="danger"
      variant="soft"
      startDecorator={<CancelIcon />}
      onClick={() => openConfirmModal('unverify', user._id, user.email, user.username)}
      loading={unverifyEmailPending}
      disabled={unverifyEmailPending}
      sx={{ width: { xs: '100%', sm: 'auto' } }}
    >
      Unverify
    </Button>
  ) : (
    <>
      <Button
        size="sm"
        color="success"
        variant="soft"
        startDecorator={<CheckCircleIcon />}
        onClick={() => openConfirmModal('verify', user._id, user.email, user.username)}
        loading={verifyEmailPending}
        disabled={verifyEmailPending}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
      >
        Verify
      </Button>
      <Button
        size="sm"
        color="primary"
        variant="soft"
        startDecorator={<EmailIcon />}
        onClick={() => openConfirmModal('resend', user._id, user.email, user.username)}
        loading={resendVerificationPending}
        disabled={resendVerificationPending}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
      >
        Resend
      </Button>
    </>
  );

  return (
    <Card
      variant="outlined"
      sx={{
        mb: { xs: 0.5, sm: 1 },
        width: '100%',
        bgcolor: index % 2 ? 'background.level1' : 'background.level2',
        p: 1,
        overflowX: { xs: 'hidden', sm: 'visible' },
      }}
    >
      {/* Mobile compact summary - visible only on xs */}
      <Box
        data-testid={`email-verify-mobile-summary-${index}`}
        onClick={() => setMobileExpanded(prev => !prev)}
        sx={{
          display: { xs: 'flex', sm: 'none' },
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
        }}
      >
        <Stack direction="column" sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight={600} noWrap>
            {user.username}
          </Typography>
          <Typography level="body-xs" color="neutral" noWrap>
            {user.email}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
          {getStatusChip(user, isExpired)}
          <IconButton size="sm" variant="plain">
            {mobileExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>
      </Box>

      {/* Mobile expanded details - visible only on xs when expanded */}
      <Box sx={{ display: { xs: mobileExpanded ? 'block' : 'none', sm: 'none' }, pt: 1 }}>
        <Stack spacing={0.5}>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-xs" color="neutral">
              Name
            </Typography>
            <Typography level="body-xs">{user.name}</Typography>
          </Stack>
          {user.pendingEmail && (
            <Stack direction="row" justifyContent="space-between">
              <Typography level="body-xs" color="neutral">
                Pending Email
              </Typography>
              <Typography level="body-xs" sx={{ color: 'primary.500' }}>
                {user.pendingEmail}
              </Typography>
            </Stack>
          )}
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-xs" color="neutral">
              Verified At
            </Typography>
            <Typography level="body-xs">{formatDate(user.emailVerifiedAt)}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-xs" color="neutral">
              Last Sent
            </Typography>
            <Typography level="body-xs">{formatDate(user.emailVerificationSentAt)}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-xs" color="neutral">
              Expires
            </Typography>
            <Typography level="body-xs">
              {user.emailVerificationExpires
                ? isExpired(user.emailVerificationExpires)
                  ? 'Expired'
                  : formatDate(user.emailVerificationExpires)
                : '-'}
            </Typography>
          </Stack>
          <Stack direction="column" spacing={0.5} sx={{ mt: 0.5 }}>
            {actionButtons}
          </Stack>
        </Stack>
      </Box>

      {/* Desktop Grid layout - always visible on sm+ */}
      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
        <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
          <Grid xs={1.5}>
            <Typography level="body-sm" sx={{ fontWeight: 500 }}>
              {user.username}
            </Typography>
          </Grid>
          <Grid xs={2}>
            <Stack spacing={0.25}>
              <Typography
                level="body-sm"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={user.email}
              >
                {user.email}
              </Typography>
              {user.pendingEmail && (
                <Typography
                  level="body-xs"
                  sx={{ color: 'primary.500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={`→ ${user.pendingEmail}`}
                >
                  → {user.pendingEmail}
                </Typography>
              )}
            </Stack>
          </Grid>
          <Grid xs={1}>
            <Typography level="body-sm">{user.name}</Typography>
          </Grid>
          <Grid xs={1}>{getStatusChip(user, isExpired)}</Grid>
          <Grid xs={1.5}>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {formatDate(user.emailVerifiedAt)}
            </Typography>
          </Grid>
          <Grid xs={1.5}>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {formatDate(user.emailVerificationSentAt)}
            </Typography>
          </Grid>
          <Grid xs={1.5}>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {user.emailVerificationExpires
                ? isExpired(user.emailVerificationExpires)
                  ? '⚠️ Expired'
                  : formatDate(user.emailVerificationExpires)
                : '-'}
            </Typography>
          </Grid>
          <Grid xs={2} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {actionButtons}
          </Grid>
        </Grid>
      </Box>
    </Card>
  );
};

const EmailVerificationTab = () => {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [statusFilter, setStatusFilter] = useState<'all' | 'verified' | 'unverified' | 'pending'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    open: false,
    type: null,
    userId: null,
    email: null,
    username: null,
    pendingEmail: null,
  });

  const queryClient = useQueryClient();
  const users = useGetEmailVerificationUsers({
    page: currentPage,
    limit: itemsPerPage,
    search: debouncedSearch,
    status: statusFilter,
  });
  const resendVerification = useResendVerification();
  const resendEmailChange = useResendEmailChange();
  const verifyEmail = useVerifyEmail();
  const unverifyEmail = useUnverifyEmail();

  const totalPages = users.data?.pagination?.totalPages || 0;
  const totalCount = users.data?.pagination?.totalCount || 0;
  const activeFilterCount = statusFilter !== 'all' ? 1 : 0;

  const openConfirmModal = (
    type: 'resend' | 'verify' | 'unverify' | 'resend-email-change',
    userId: string,
    email: string,
    username: string,
    pendingEmail?: string
  ) => {
    setConfirmModal({
      open: true,
      type,
      userId,
      email,
      username,
      pendingEmail,
    });
  };

  const closeConfirmModal = () => {
    setConfirmModal({
      open: false,
      type: null,
      userId: null,
      email: null,
      username: null,
      pendingEmail: null,
    });
  };

  const handleConfirmAction = async () => {
    if (!confirmModal.userId || !confirmModal.type) return;

    try {
      switch (confirmModal.type) {
        case 'resend':
          await resendVerification.mutateAsync(confirmModal.userId);
          toast.success(`Verification email resent to ${confirmModal.email}`);
          break;
        case 'verify':
          await verifyEmail.mutateAsync(confirmModal.userId);
          toast.success(`Email verified for ${confirmModal.username}`);
          break;
        case 'unverify':
          await unverifyEmail.mutateAsync(confirmModal.userId);
          toast.success(`Email unverified for ${confirmModal.username}`);
          break;
        case 'resend-email-change':
          await resendEmailChange.mutateAsync(confirmModal.userId);
          toast.success(`Email change verification resent to ${confirmModal.pendingEmail}`);
          break;
      }
      closeConfirmModal();
    } catch (error: any) {
      // Backend sends error message in 'error' field, not 'message'
      const errorMessage =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        `Failed to ${confirmModal.type} email`;
      toast.error(errorMessage);

      // Close modal even on error
      closeConfirmModal();

      // Refresh data to reflect any backend state changes (e.g., expired token auto-cancelled)
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    }
  };

  const handleRefresh = () => {
    users.refetch();
  };

  const formatDate = (date?: Date) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString() + ' ' + new Date(date).toLocaleTimeString();
  };

  const isExpired = (expiresAt?: Date) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  return (
    <Sheet sx={{ px: { xs: 1, sm: 2 }, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ flexShrink: 0 }}>
        {/* Search & Filter Controls */}
        <Card sx={{ px: { xs: 1, sm: 2 }, py: 1, mb: 1 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="end">
              <FormControl sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5, display: { xs: 'none', sm: 'block' } }}>
                  Search Users
                </Typography>
                <Input
                  size="sm"
                  startDecorator={<EmailIcon />}
                  placeholder="Search by username, email, or name..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </FormControl>

              {/* Mobile-only filter toggle */}
              <IconButton
                data-testid="email-verify-filter-toggle"
                variant={showFilters ? 'soft' : 'plain'}
                color={activeFilterCount > 0 ? 'primary' : 'neutral'}
                onClick={() => setShowFilters(prev => !prev)}
                sx={{ display: { xs: 'flex', sm: 'none' }, flexShrink: 0 }}
              >
                <Badge badgeContent={activeFilterCount} badgeInset="14%">
                  <FilterListIcon />
                </Badge>
              </IconButton>

              {/* Desktop-only: inline status filter + refresh */}
              <FormControl sx={{ minWidth: 180, display: { xs: 'none', sm: 'flex' } }}>
                <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                  Status
                </Typography>
                <Select
                  size="sm"
                  value={statusFilter}
                  onChange={(_, value) => {
                    setStatusFilter(value as 'all' | 'verified' | 'unverified' | 'pending');
                    setCurrentPage(1);
                  }}
                >
                  <Option value="all">All Users</Option>
                  <Option value="verified">Verified</Option>
                  <Option value="unverified">Unverified</Option>
                  <Option value="pending">Pending Verification</Option>
                </Select>
              </FormControl>

              <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ display: { xs: 'none', sm: 'flex' } }}>
                <Button size="sm" startDecorator={<RefreshIcon />} onClick={handleRefresh} disabled={users.isPending}>
                  Refresh
                </Button>
                <ContextHelpButton helpId="admin/email-verification" tooltipText="Email Verification Help" />
              </Stack>
            </Stack>

            {/* Mobile collapsible filters */}
            <Box sx={{ display: { xs: showFilters ? 'flex' : 'none', sm: 'none' }, flexDirection: 'column', gap: 1 }}>
              <FormControl>
                <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                  Status
                </Typography>
                <Select
                  size="sm"
                  value={statusFilter}
                  onChange={(_, value) => {
                    setStatusFilter(value as 'all' | 'verified' | 'unverified' | 'pending');
                    setCurrentPage(1);
                  }}
                >
                  <Option value="all">All Users</Option>
                  <Option value="verified">Verified</Option>
                  <Option value="unverified">Unverified</Option>
                  <Option value="pending">Pending Verification</Option>
                </Select>
              </FormControl>
              <Stack direction="row" spacing={1}>
                <Button size="sm" startDecorator={<RefreshIcon />} onClick={handleRefresh} disabled={users.isPending}>
                  Refresh
                </Button>
                <ContextHelpButton helpId="admin/email-verification" tooltipText="Email Verification Help" />
              </Stack>
            </Box>
          </Stack>
        </Card>

        {users.isPending && <LinearProgress />}

        {/* Top pagination - hidden on mobile */}
        <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
            itemsPerPage={itemsPerPage}
            onItemsPerPageChange={size => {
              setItemsPerPage(size);
              setCurrentPage(1);
            }}
            totalCount={totalCount}
          />
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {/* Sticky Header - hidden on mobile */}
        <Card
          variant="outlined"
          sx={{
            mb: 1,
            width: '100%',
            bgcolor: 'background.surface',
            p: 1,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            borderBottom: 2,
            borderColor: 'divider',
            display: { xs: 'none', sm: 'block' },
          }}
        >
          <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
            <Grid xs={1.5}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Username
              </Typography>
            </Grid>
            <Grid xs={2}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Email
              </Typography>
            </Grid>
            <Grid xs={1}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Name
              </Typography>
            </Grid>
            <Grid xs={1}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Status
              </Typography>
            </Grid>
            <Grid xs={1.5}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Verified At
              </Typography>
            </Grid>
            <Grid xs={1.5}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Last Sent
              </Typography>
            </Grid>
            <Grid xs={1.5}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Expires
              </Typography>
            </Grid>
            <Grid xs={2}>
              <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Actions
              </Typography>
            </Grid>
          </Grid>
        </Card>

        {/* Data Rows */}
        {users.data?.users.map((user: User, index: number) => (
          <EmailVerificationRow
            key={user._id}
            user={user}
            index={index}
            formatDate={formatDate}
            isExpired={isExpired}
            openConfirmModal={openConfirmModal}
            resendEmailChangePending={resendEmailChange.isPending}
            unverifyEmailPending={unverifyEmail.isPending}
            verifyEmailPending={verifyEmail.isPending}
            resendVerificationPending={resendVerification.isPending}
          />
        ))}
      </Box>

      <Box sx={{ flexShrink: 0 }}>
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
          itemsPerPage={itemsPerPage}
          onItemsPerPageChange={size => {
            setItemsPerPage(size);
            setCurrentPage(1);
          }}
          totalCount={totalCount}
        />
      </Box>

      {/* Confirmation Modal */}
      <Modal open={confirmModal.open} onClose={closeConfirmModal}>
        <ModalDialog size="sm" variant="outlined">
          <ModalClose />
          <Typography level="h4" startDecorator={<WarningIcon />}>
            {confirmModal.type === 'resend' && 'Resend Verification Email'}
            {confirmModal.type === 'verify' && 'Verify Email'}
            {confirmModal.type === 'unverify' && 'Unverify Email'}
            {confirmModal.type === 'resend-email-change' && 'Resend Email Change Verification'}
          </Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            {confirmModal.type === 'resend' &&
              `Are you sure you want to resend the verification email to ${confirmModal.email}?`}
            {confirmModal.type === 'verify' &&
              `Are you sure you want to manually verify the email for ${confirmModal.username} (${confirmModal.email})?`}
            {confirmModal.type === 'unverify' &&
              `Are you sure you want to unverify the email for ${confirmModal.username} (${confirmModal.email})? This will require the user to verify their email again.`}
            {confirmModal.type === 'resend-email-change' &&
              `Are you sure you want to resend the email change verification to ${confirmModal.pendingEmail}?`}
          </Typography>
          <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
            <Button variant="outlined" color="neutral" onClick={closeConfirmModal}>
              Cancel
            </Button>
            <Button
              color={confirmModal.type === 'unverify' ? 'danger' : 'primary'}
              onClick={handleConfirmAction}
              loading={
                resendVerification.isPending ||
                verifyEmail.isPending ||
                unverifyEmail.isPending ||
                resendEmailChange.isPending
              }
            >
              {confirmModal.type === 'resend' && 'Yes, Resend'}
              {confirmModal.type === 'verify' && 'Yes, Verify'}
              {confirmModal.type === 'unverify' && 'Yes, Unverify'}
              {confirmModal.type === 'resend-email-change' && 'Yes, Resend'}
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Sheet>
  );
};

export default EmailVerificationTab;

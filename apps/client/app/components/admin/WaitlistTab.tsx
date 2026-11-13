import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { deleteSubscriber, fetchSubscribers } from '@client/app/utils/subscriberAPICalls';
import { ISubscriberDocument, SubscriberSource, isSignupClosedSource } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general'; // brand externalized
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import {
  Button,
  Input,
  Stack,
  Typography,
  FormControl,
  FormLabel,
  Textarea,
  Box,
  Alert,
  Chip,
  Dropdown,
  Menu,
  MenuButton,
  MenuItem,
  IconButton,
} from '@mui/joy';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { GRANT_PACKAGES_QUERY_KEY } from '@client/app/utils/grantPackageAPICalls';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useAdminNotifications } from './AdminPage';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import { ActionDialog } from './shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { DataTable, type DataColumn } from './shared/DataTable';
import { EmptyState } from './shared/EmptyState';
import { AdminSearchInput } from './shared/FilterBar';
import { StatusChip } from './shared/StatusChip';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { InviteCenterShell } from './InviteCenterShell';
import { SubscriberNetworkCell, SuspiciousNameChip } from './WaitlistSignals';
import GrantPackageSelect, { useGrantPackageOptions } from './InviteCenter/shared/GrantPackageSelect';

const SOURCE_LABELS: Record<SubscriberSource, string> = {
  subscribe_page: 'Waitlist page',
  login_signup_closed: 'Blocked sign-in',
  register_signup_closed: 'Blocked sign-up',
  oauth_signup_closed: 'Blocked Google/GitHub',
  coming_soon_page: 'Coming soon page',
};

// Entries from before the source field existed all came through the waitlist page.
const SubscriberSourceChip = ({ source = 'subscribe_page' }: { source?: SubscriberSource }) => (
  <Chip size="sm" variant="outlined" color={isSignupClosedSource(source) ? 'warning' : 'neutral'}>
    {SOURCE_LABELS[source]}
  </Chip>
);

const useGetSubscribers = (params: { page?: number; limit?: number; search?: string }) => {
  return useQuery({
    queryKey: ['subscribers', params],
    queryFn: () => fetchSubscribers(params),
    placeholderData: keepPreviousData,
  });
};

const useGenerateSubscriberInvite = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      subscriberId: string;
      email: string;
      firstName: string;
      lastName: string;
      startingCredits: number;
      startingStorage: number;
      grantPackageId?: string;
      emailBody?: string;
    }) => {
      const response = await api.post('/api/subscribers/generate-invite', data);
      return response.data;
    },
    onSuccess: () => {
      // ['subscribers'] also covers the waiting count this tab shows.
      queryClient.invalidateQueries({ queryKey: ['subscribers'] });
      queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey });
      queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
  });
};

interface GenerateInviteDialogProps {
  open: boolean;
  onClose: () => void;
  subscriber: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
}

const GenerateInviteDialog = ({ open, onClose, subscriber }: GenerateInviteDialogProps) => {
  const [startingCredits, setStartingCredits] = useState(500);
  const [startingStorage, setStartingStorage] = useState(1000);
  const [grantPackageId, setGrantPackageId] = useState<string | null>(null);
  const [emailBody, setEmailBody] = useState('');
  const [inviteIssued, setInviteIssued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateInvite = useGenerateSubscriberInvite();
  const { data: packageList } = useGrantPackageOptions();
  const selectedPackage = grantPackageId ? packageList?.data.find(pkg => pkg.id === grantPackageId) : undefined;
  const effectiveCredits = selectedPackage ? selectedPackage.credits : startingCredits;
  const effectiveStorage = selectedPackage?.storageMb ?? startingStorage;

  const resetAndClose = () => {
    onClose();
    setStartingCredits(500);
    setStartingStorage(1000);
    setGrantPackageId(null);
    setInviteIssued(false);
    setError(null);
    setEmailBody('');
  };

  // The invite endpoint does not take a reason yet, so it is collected but not sent (reasonAudited={false}).
  const handleConfirm = async () => {
    if (!subscriber) return;
    setError(null);

    const defaultEmailBody = `Hi ${subscriber.firstName},

Thank you for your interest${APP_NAME ? ` in ${APP_NAME}` : ''}! We're excited to welcome you to our platform.

Your account has been set up with:
\u2022 ${effectiveCredits.toLocaleString()} credits to get you started
\u2022 ${effectiveStorage} MB of storage space

Use your invite code below to complete your registration and start exploring our AI-powered tools.

Welcome aboard!

The${APP_NAME ? ` ${APP_NAME}` : ''} Team`;

    try {
      const result = await generateInvite.mutateAsync({
        subscriberId: subscriber.id,
        email: subscriber.email,
        firstName: subscriber.firstName,
        lastName: subscriber.lastName,
        startingCredits,
        startingStorage,
        ...(grantPackageId ? { grantPackageId } : {}),
        emailBody: emailBody || defaultEmailBody,
      });

      // Leave the dialog open so the admin can copy the code from the message.
      if (result?.emailSent === false) {
        setInviteIssued(true);
        setError(result.message);
        return;
      }

      toast.success(`Invite code generated and sent to ${subscriber.email}`);
      resetAndClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to generate invite';
      const apiMessage = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(apiMessage || message);
      throw err;
    }
  };

  if (!subscriber) return null;

  return (
    <ActionDialog
      open={open}
      onClose={resetAndClose}
      title="Generate invite code"
      description={
        <>
          For{' '}
          <strong>
            {subscriber.firstName} {subscriber.lastName}
          </strong>{' '}
          ({subscriber.email}). The invite code is emailed to them.
        </>
      }
      reasonPresets={ADMIN_REASON_PRESETS.waitlistInvite}
      reasonAudited={false}
      confirmLabel="Generate and send invite"
      pending={generateInvite.isPending}
      blockedReason={inviteIssued ? 'The invite code was generated. Close this dialog when you are done.' : null}
      onConfirm={handleConfirm}
      data-testid="waitlist-invite-dialog"
    >
      <GrantPackageSelect
        value={grantPackageId}
        onChange={setGrantPackageId}
        testId="waitlist-invite-grant-package-select"
        helperText="A package supplies the credits and storage and enforces its signup caps."
      />

      <Box sx={{ display: 'flex', gap: 2 }}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Starting credits</FormLabel>
          <Input
            disabled={grantPackageId !== null}
            type="number"
            value={effectiveCredits}
            onChange={e => setStartingCredits(parseInt(e.target.value) || 0)}
            endDecorator="credits"
            slotProps={{ input: { min: 0, step: 100, 'data-testid': 'waitlist-invite-credits-input' } }}
          />
        </FormControl>

        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Starting storage</FormLabel>
          <Input
            disabled={selectedPackage?.storageMb != null}
            type="number"
            value={effectiveStorage}
            onChange={e => setStartingStorage(parseInt(e.target.value) || 0)}
            endDecorator="MB"
            slotProps={{ input: { min: 0, step: 100, 'data-testid': 'waitlist-invite-storage-input' } }}
          />
        </FormControl>
      </Box>

      <FormControl>
        <FormLabel>Email message (optional)</FormLabel>
        <Textarea
          minRows={6}
          maxRows={10}
          placeholder="Leave blank to use the default welcome message..."
          value={emailBody}
          onChange={e => setEmailBody(e.target.value)}
        />
        <Typography level="body-xs" sx={{ mt: 1, opacity: 0.7 }}>
          If left blank, a default welcome message will be used with the credit and storage information.
        </Typography>
      </FormControl>

      {error && <Alert color="danger">{error}</Alert>}
    </ActionDialog>
  );
};

const WaitlistSection = () => {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  // Back to page 1 when the debounced term changes, before the query keys on it.
  const [pageSearch, setPageSearch] = useState(debouncedSearch);
  if (pageSearch !== debouncedSearch) {
    setPageSearch(debouncedSearch);
    setCurrentPage(1);
  }
  const [selectedSubscriber, setSelectedSubscriber] = useState<ISubscriberDocument | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);

  const [hiddenNotifications, hideNotification] = useAdminNotifications(
    useShallow(state => [state.hiddenNotifications, state.hideNotification])
  );
  const waitingSubscribers = useGetWaitingSubscribersCount();

  const subscribers = useGetSubscribers({ page: currentPage, limit: itemsPerPage, search: debouncedSearch });

  const handleDelete = async (id: string) => {
    if (window.confirm('Remove this person from the waitlist?')) {
      try {
        await deleteSubscriber(id);
        // Removing a page's only row would otherwise land on an empty page.
        if (currentPage > 1 && subscribers.data?.data.length === 1) setCurrentPage(currentPage - 1);
        else subscribers.refetch();
      } catch (error) {
        console.error('Error deleting subscriber:', error);
      }
    }
  };

  const handleGenerateInvite = (subscriber: ISubscriberDocument) => {
    setSelectedSubscriber(subscriber);
    setInviteModalOpen(true);
  };

  const columns: DataColumn<ISubscriberDocument>[] = [
    {
      id: 'name',
      label: 'Name',
      render: subscriber => (
        <Stack spacing={0.5} alignItems="flex-start">
          <span>{`${subscriber.firstName} ${subscriber.lastName}`}</span>
          {subscriber.suspicious && <SuspiciousNameChip reasons={subscriber.suspicious.reasons} />}
        </Stack>
      ),
    },
    { id: 'email', label: 'Email', render: subscriber => subscriber.email },
    { id: 'date', label: 'Date', render: subscriber => new Date(subscriber.createdAt).toLocaleDateString() },
    { id: 'source', label: 'Source', render: subscriber => <SubscriberSourceChip source={subscriber.source} /> },
    {
      id: 'network',
      label: 'Network',
      width: '17.5rem',
      render: subscriber => <SubscriberNetworkCell network={subscriber.signupNetwork} />,
    },
    {
      id: 'status',
      label: 'Status',
      render: subscriber => (
        <StatusChip
          tone={subscriber.inviteGenerated ? 'good' : 'neutral'}
          label={subscriber.inviteGenerated ? 'Invite sent' : 'Waiting'}
        />
      ),
    },
  ];

  const rowActions = (subscriber: ISubscriberDocument) => (
    <>
      <Button
        size="sm"
        variant="plain"
        startDecorator={<PersonAddIcon />}
        onClick={() => handleGenerateInvite(subscriber)}
        disabled={subscriber.inviteGenerated}
        data-testid={`waitlist-generate-invite-${subscriber.id}`}
      >
        Generate invite
      </Button>
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{
            root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for ${subscriber.email}` },
          }}
          data-testid={`waitlist-row-actions-${subscriber.id}`}
        >
          <MoreHorizIcon sx={{ fontSize: 18 }} />
        </MenuButton>
        <Menu size="sm" placement="bottom-end">
          <MenuItem
            color="danger"
            onClick={() => handleDelete(subscriber.id)}
            data-testid={`waitlist-remove-${subscriber.id}`}
          >
            Remove from waitlist
          </MenuItem>
        </Menu>
      </Dropdown>
    </>
  );

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      {!!waitingSubscribers.data?.count && !hiddenNotifications.includes('waiting-subscribers') && (
        <Alert
          color="warning"
          variant="soft"
          endDecorator={
            <IconButton
              size="sm"
              variant="plain"
              aria-label="Dismiss waitlist notice"
              onClick={() => hideNotification('waiting-subscribers')}
            >
              <CloseIcon />
            </IconButton>
          }
        >
          <span>
            There {waitingSubscribers.data.count === 1 ? 'is' : 'are'} <strong>{waitingSubscribers.data.count}</strong>{' '}
            {waitingSubscribers.data.count === 1 ? 'person' : 'people'} on the waitlist waiting for an invite.
          </span>
        </Alert>
      )}

      <Stack gap={1.5}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="body-sm" color="neutral">
            Manage waitlist requests and generate invite codes with custom credits and storage allocations
          </Typography>
          <ContextHelpButton helpId="admin/waitlist" tooltipText="Waitlist Help" />
        </Stack>
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
          <AdminSearchInput
            value={search}
            onChange={setSearch}
            label="Search the waitlist"
            data-testid="waitlist-search-input"
          />
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<RefreshIcon />}
            onClick={() => subscribers.refetch()}
            disabled={subscribers.isFetching}
            data-testid="waitlist-refresh-btn"
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      <DataTable
        label="Waitlist"
        testId="waitlist-table"
        rows={subscribers.data?.data ?? []}
        columns={columns}
        getRowId={subscriber => subscriber.id}
        loading={subscribers.isPending}
        error={subscribers.isError ? 'The waitlist could not be loaded.' : undefined}
        onRetry={() => subscribers.refetch()}
        empty={
          <EmptyState
            title={debouncedSearch ? 'No one on the waitlist matches your search' : 'The waitlist is empty'}
            description={debouncedSearch ? 'Try a different name or email.' : 'People who ask for access appear here.'}
            action={
              debouncedSearch ? (
                <Button variant="outlined" color="neutral" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : null
            }
          />
        }
        rowActions={rowActions}
        minWidth="56rem"
        maxHeight="none"
        pagination={{
          page: currentPage,
          pageSize: itemsPerPage,
          total: subscribers.data?.meta?.total ?? 0,
          onPageChange: setCurrentPage,
          onPageSizeChange: size => {
            setItemsPerPage(size);
            setCurrentPage(1);
          },
        }}
      />

      <GenerateInviteDialog
        key={selectedSubscriber?.id}
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        subscriber={selectedSubscriber}
      />
    </Stack>
  );
};

const WaitlistTab = () => <InviteCenterShell waitlist={<WaitlistSection />} />;

export default WaitlistTab;

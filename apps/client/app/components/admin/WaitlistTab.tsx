import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { deleteSubscriber, fetchSubscribers } from '@client/app/utils/subscriberAPICalls';
import { ISubscriberDocument, SubscriberSource } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general'; // brand externalized
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import {
  Button,
  Input,
  LinearProgress,
  Sheet,
  Stack,
  Table,
  Typography,
  FormControl,
  FormLabel,
  Textarea,
  Box,
  Alert,
  Chip,
  Card,
  CardContent,
  Divider,
  RadioGroup,
  Radio,
  Select,
  Option,
  IconButton,
  useTheme,
} from '@mui/joy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useAdminNotifications } from './AdminPage';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import { ActionDialog } from './shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';

const SOURCE_LABELS: Record<SubscriberSource, string> = {
  subscribe_page: 'Waitlist page',
  login_signup_closed: 'Blocked sign-in',
  register_signup_closed: 'Blocked sign-up',
  oauth_signup_closed: 'Blocked Google/GitHub',
};

// Entries from before the source field existed all came through the waitlist page.
const SubscriberSourceChip = ({ source = 'subscribe_page' }: { source?: SubscriberSource }) => (
  <Chip size="sm" variant="outlined" color={source === 'subscribe_page' ? 'neutral' : 'warning'}>
    {SOURCE_LABELS[source]}
  </Chip>
);

const useGetSubscribers = (params: { page?: number; limit?: number; search?: string }) => {
  return useQuery({
    queryKey: ['subscribers', params],
    queryFn: () => fetchSubscribers(params),
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
      emailBody?: string;
    }) => {
      const response = await api.post('/api/subscribers/generate-invite', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers'] });
      // Also invalidate the waiting count badge in admin navigation
      queryClient.invalidateQueries({ queryKey: ['subscribers', 'waiting-count'] });
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
  const [emailBody, setEmailBody] = useState('');
  const [inviteIssued, setInviteIssued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateInvite = useGenerateSubscriberInvite();

  const resetAndClose = () => {
    onClose();
    setStartingCredits(500);
    setStartingStorage(1000);
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
\u2022 ${startingCredits.toLocaleString()} credits to get you started
\u2022 ${startingStorage} MB of storage space

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
      <Box sx={{ display: 'flex', gap: 2 }}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Starting credits</FormLabel>
          <Input
            type="number"
            value={startingCredits}
            onChange={e => setStartingCredits(parseInt(e.target.value) || 0)}
            endDecorator="credits"
            slotProps={{ input: { min: 0, step: 100 } }}
          />
        </FormControl>

        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Starting storage</FormLabel>
          <Input
            type="number"
            value={startingStorage}
            onChange={e => setStartingStorage(parseInt(e.target.value) || 0)}
            endDecorator="MB"
            slotProps={{ input: { min: 0, step: 100 } }}
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
}) => {
  const isMobile = useIsMobile();
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      justifyContent="space-between"
      alignItems="center"
      sx={{ mt: 2, mb: 2 }}
      spacing={{ xs: 2, sm: 0 }}
    >
      <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
        <Button disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>
          Previous
        </Button>
        <Typography>
          Page {currentPage} of {totalPages}
        </Typography>
        <Button disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>
          Next
        </Button>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
        <FormControl>
          {isMobile ? (
            <Select
              size="sm"
              value={itemsPerPage}
              onChange={(_, value) => value !== null && onItemsPerPageChange(Number(value))}
              sx={{ minWidth: 120 }}
            >
              {[5, 10, 20].map(value => (
                <Option key={value} value={value}>
                  {value} per page
                </Option>
              ))}
            </Select>
          ) : (
            <RadioGroup
              orientation="horizontal"
              value={itemsPerPage}
              onChange={e => onItemsPerPageChange(Number(e.target.value))}
            >
              {[5, 10, 20].map(value => (
                <Radio key={value} value={value} label={`${value} per page`} size="sm" sx={{ mr: 2 }} />
              ))}
            </RadioGroup>
          )}
        </FormControl>
        <Typography level="title-sm" fontWeight={800}>
          Total Items: {totalCount}
        </Typography>
      </Stack>
    </Stack>
  );
};

const WaitlistTab = () => {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [selectedSubscriber, setSelectedSubscriber] = useState<ISubscriberDocument | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const isMobile = useIsMobile();

  const [hiddenNotifications, hideNotification] = useAdminNotifications(
    useShallow(state => [state.hiddenNotifications, state.hideNotification])
  );
  const waitingSubscribers = useGetWaitingSubscribersCount();

  const subscribers = useGetSubscribers({ page: currentPage, limit: itemsPerPage, search: debouncedSearch });
  const totalPages = Math.ceil((subscribers.data?.meta?.total || 0) / itemsPerPage);

  const handleDelete = async (id: string) => {
    if (window.confirm('Remove this person from the waitlist?')) {
      try {
        await deleteSubscriber(id);
        subscribers.refetch();
      } catch (error) {
        console.error('Error deleting subscriber:', error);
      }
    }
  };

  const handleGenerateInvite = (subscriber: ISubscriberDocument) => {
    setSelectedSubscriber(subscriber);
    setInviteModalOpen(true);
  };

  const handleRefresh = () => {
    subscribers.refetch();
  };

  return (
    <Sheet sx={{ px: 2, py: 1 }}>
      <Stack spacing={2}>
        {/* Waitlist notification banner */}
        {!!waitingSubscribers.data?.count &&
          waitingSubscribers.data.count > 0 &&
          !hiddenNotifications.includes('waiting-subscribers') && (
            <Alert
              color="warning"
              variant="soft"
              sx={{ mb: 2 }}
              endDecorator={
                <IconButton
                  size="sm"
                  variant="plain"
                  onClick={() => hideNotification('waiting-subscribers')}
                  sx={{ color: 'warning.600' }}
                >
                  <CloseIcon />
                </IconButton>
              }
            >
              <Typography level="body-md" sx={{ color: isDarkMode ? 'warning.300' : 'warning.700' }}>
                There {waitingSubscribers.data.count === 1 ? 'is' : 'are'}{' '}
                <strong>{waitingSubscribers.data.count}</strong>{' '}
                {waitingSubscribers.data.count === 1 ? 'person' : 'people'} on the waitlist waiting for an invite.
              </Typography>
            </Alert>
          )}

        {/* Header Section */}
        <Card sx={{ mb: 2 }}>
          <Stack spacing={1}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography level="body-sm" color="neutral">
                Manage waitlist requests and generate invite codes with custom credits and storage allocations
              </Typography>
              <ContextHelpButton helpId="admin/waitlist" tooltipText="Waitlist Help" />
            </Stack>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'stretch', sm: 'center' }}
              spacing={{ xs: 2, sm: 0 }}
            >
              <Input
                placeholder="Search the waitlist..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                sx={{ minWidth: { xs: 0, sm: 450 }, width: { xs: '100%', sm: 'auto' } }}
              />

              <Button
                size="sm"
                startDecorator={<RefreshIcon />}
                onClick={handleRefresh}
                disabled={subscribers.isPending}
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                Refresh
              </Button>
            </Stack>
          </Stack>
        </Card>

        {subscribers.isPending && <LinearProgress />}

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
            totalCount={subscribers.data?.meta?.total || 0}
          />
        </Box>

        {isMobile ? (
          <Stack spacing={1.5}>
            {subscribers.data?.data.map(subscriber => (
              <Card key={subscriber.id} variant="outlined">
                <CardContent sx={{ p: 1.5 }}>
                  <Stack spacing={0.75}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography fontWeight="bold">{`${subscriber.firstName} ${subscriber.lastName}`}</Typography>
                      <Chip size="sm" color={subscriber.inviteGenerated ? 'success' : 'neutral'}>
                        {subscriber.inviteGenerated ? 'Invite Sent' : 'Waiting'}
                      </Chip>
                    </Stack>
                    <Typography level="body-sm" sx={{ wordBreak: 'break-word', color: 'text.secondary' }}>
                      {subscriber.email}
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography level="body-xs" color="neutral">
                        {new Date(subscriber.createdAt).toLocaleDateString()}
                      </Typography>
                      <SubscriberSourceChip source={subscriber.source} />
                    </Stack>
                    <Divider />
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="sm"
                        color="primary"
                        variant="soft"
                        startDecorator={<PersonAddIcon />}
                        onClick={() => handleGenerateInvite(subscriber)}
                        disabled={subscriber.inviteGenerated}
                        sx={{ flex: 1 }}
                      >
                        Generate Invite
                      </Button>
                      <Button size="sm" color="danger" variant="soft" onClick={() => handleDelete(subscriber.id)}>
                        Delete
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        ) : (
          <Box sx={{ overflowX: { xs: 'auto', sm: 'visible' } }}>
            <Table sx={{ minWidth: { xs: '800px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.data?.data.map(subscriber => (
                  <tr key={subscriber.id}>
                    <td>{`${subscriber.firstName} ${subscriber.lastName}`}</td>
                    <td>{subscriber.email}</td>
                    <td>{new Date(subscriber.createdAt).toLocaleDateString()}</td>
                    <td>
                      <SubscriberSourceChip source={subscriber.source} />
                    </td>
                    <td>
                      <Chip size="sm" color={subscriber.inviteGenerated ? 'success' : 'neutral'}>
                        {subscriber.inviteGenerated ? 'Invite Sent' : 'Waiting'}
                      </Chip>
                    </td>
                    <td>
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="sm"
                          color="primary"
                          variant="soft"
                          startDecorator={<PersonAddIcon />}
                          onClick={() => handleGenerateInvite(subscriber)}
                          disabled={subscriber.inviteGenerated}
                        >
                          Generate Invite
                        </Button>
                        <Button size="sm" color="danger" variant="soft" onClick={() => handleDelete(subscriber.id)}>
                          Delete
                        </Button>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        )}
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
          itemsPerPage={itemsPerPage}
          onItemsPerPageChange={size => {
            setItemsPerPage(size);
            setCurrentPage(1);
          }}
          totalCount={subscribers.data?.meta?.total || 0}
        />
      </Stack>

      <GenerateInviteDialog
        key={selectedSubscriber?.id}
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        subscriber={selectedSubscriber}
      />
    </Sheet>
  );
};

export default WaitlistTab;

/**
 * Lists and manages a user's subscriptions to organization webhooks: subscribe,
 * enable/disable, and view delivery statistics.
 */

import { FC, useState, useCallback } from 'react';
import {
  Card,
  Typography,
  Box,
  Button,
  Stack,
  Chip,
  IconButton,
  Switch,
  Alert,
  Skeleton,
  Table,
  Divider,
  Modal,
  ModalDialog,
  ModalClose,
  FormControl,
  FormLabel,
  Select,
  Option,
  Tooltip,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import GitHubIcon from '@mui/icons-material/GitHub';
import WarningIcon from '@mui/icons-material/Warning';
import RefreshIcon from '@mui/icons-material/Refresh';
import HistoryIcon from '@mui/icons-material/History';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import {
  useGetWebhookSubscriptions,
  useCreateWebhookSubscription,
  useUpdateWebhookSubscription,
  useDeleteWebhookSubscription,
  useReEnableWebhookSubscription,
} from '@client/app/hooks/data/useWebhookSubscriptions';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { useUser } from '@client/app/contexts/UserContext';
import { IWebhookSubscriptionResponse } from '@bike4mind/common';

interface WebhookSubscriptionsProps {
  onViewHistory?: (subscriptionId: string) => void;
}

const WebhookSubscriptions: FC<WebhookSubscriptionsProps> = ({ onViewHistory }) => {
  const setConfirmationModal = useConfirmationModal.setState;
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const user = useUser(s => s.currentUser);
  const { data: subscriptions, isLoading, error, refetch } = useGetWebhookSubscriptions();
  const { data: organizations } = useGetUserOrganizations(user?.id);

  const createSubscription = useCreateWebhookSubscription();
  const updateSubscription = useUpdateWebhookSubscription();
  const deleteSubscription = useDeleteWebhookSubscription();
  const reEnableSubscription = useReEnableWebhookSubscription();

  // Filter organizations that don't already have a subscription
  const availableOrgs = organizations?.filter(org => !subscriptions?.some(sub => sub.organizationId === org.id));

  const handleToggleEnabled = useCallback(
    async (subscription: IWebhookSubscriptionResponse) => {
      await updateSubscription.mutateAsync({
        id: subscription.id,
        data: { enabled: !subscription.enabled },
      });
    },
    [updateSubscription]
  );

  const handleDelete = useCallback(
    (subscription: IWebhookSubscriptionResponse) => {
      setConfirmationModal({
        open: true,
        type: 'danger',
        title: 'Unsubscribe from Webhook',
        description:
          `Are you sure you want to unsubscribe from ${subscription.organizationName || 'this organization'}? ` +
          'You will no longer receive webhook events.',
        okLabel: 'Unsubscribe',
        onOk: async () => {
          await deleteSubscription.mutateAsync(subscription.id);
        },
      });
    },
    [deleteSubscription, setConfirmationModal]
  );

  const handleReEnable = useCallback(
    async (subscription: IWebhookSubscriptionResponse) => {
      await reEnableSubscription.mutateAsync(subscription.id);
    },
    [reEnableSubscription]
  );

  const handleCreateSubscription = useCallback(async () => {
    if (!selectedOrgId) return;

    await createSubscription.mutateAsync({
      organizationId: selectedOrgId,
      repos: [],
      events: [],
      enabled: true,
    });

    setShowAddModal(false);
    setSelectedOrgId(null);
  }, [selectedOrgId, createSubscription]);

  if (isLoading) {
    return (
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
          Webhook Subscriptions
        </Typography>
        <Stack spacing={2} sx={{ p: 2 }}>
          <Skeleton variant="rectangular" height={60} />
          <Skeleton variant="rectangular" height={60} />
        </Stack>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
          Webhook Subscriptions
        </Typography>
        <Box sx={{ p: 2 }}>
          <Alert
            color="danger"
            variant="soft"
            endDecorator={
              <Button size="sm" variant="soft" color="danger" onClick={() => refetch()}>
                Retry
              </Button>
            }
          >
            Failed to load webhook subscriptions. Please try again.
          </Alert>
        </Box>
      </Card>
    );
  }

  return (
    <>
      <Card variant="outlined">
        <Box
          sx={{
            p: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography level="title-sm">
            <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            Webhook Subscriptions
          </Typography>
          {availableOrgs && availableOrgs.length > 0 && (
            <Button size="sm" onClick={() => setShowAddModal(true)} data-testid="add-subscription-btn">
              Subscribe to Organization
            </Button>
          )}
        </Box>

        {subscriptions && subscriptions.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Status</th>
                <th style={{ width: 120 }}>Enabled</th>
                <th style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map(subscription => (
                <tr key={subscription.id}>
                  <td>
                    <Typography level="body-sm" fontWeight="md">
                      {subscription.organizationName || subscription.organizationId}
                    </Typography>
                    {subscription.repos && subscription.repos.length > 0 ? (
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {subscription.repos.length} repo(s)
                      </Typography>
                    ) : (
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        All repos
                      </Typography>
                    )}
                  </td>
                  <td>
                    {subscription.autoDisabledAt ? (
                      <Chip variant="soft" color="danger" size="sm" startDecorator={<WarningIcon />}>
                        Auto-disabled
                      </Chip>
                    ) : subscription.enabled ? (
                      <Chip variant="soft" color="success" size="sm">
                        Active
                      </Chip>
                    ) : (
                      <Chip variant="soft" color="neutral" size="sm">
                        Paused
                      </Chip>
                    )}
                  </td>
                  <td>
                    {subscription.autoDisabledAt ? (
                      <Button
                        size="sm"
                        variant="outlined"
                        color="warning"
                        onClick={() => handleReEnable(subscription)}
                        loading={reEnableSubscription.isPending}
                        startDecorator={<RefreshIcon />}
                      >
                        Re-enable
                      </Button>
                    ) : (
                      <Switch
                        checked={subscription.enabled}
                        onChange={() => handleToggleEnabled(subscription)}
                        disabled={updateSubscription.isPending}
                      />
                    )}
                  </td>
                  <td>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {onViewHistory && (
                        <Tooltip title="View delivery history">
                          <IconButton
                            size="sm"
                            variant="plain"
                            onClick={() => onViewHistory(subscription.id)}
                            data-testid={`view-history-${subscription.id}`}
                          >
                            <HistoryIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => handleDelete(subscription)}
                        data-testid={`delete-subscription-${subscription.id}`}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Box>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 2 }}>
              No webhook subscriptions yet.
            </Typography>
            {availableOrgs && availableOrgs.length > 0 ? (
              <Button onClick={() => setShowAddModal(true)}>Subscribe to Organization Webhook</Button>
            ) : (
              <Alert color="neutral">
                Your organizations don&apos;t have webhook configurations set up yet. Contact your organization admin to
                enable GitHub webhooks.
              </Alert>
            )}
          </Box>
        )}
      </Card>

      {/* Add Subscription Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)}>
        <ModalDialog sx={{ minWidth: 400 }}>
          <ModalClose />
          <Typography level="title-lg">Subscribe to Organization Webhook</Typography>
          <Divider />
          <Stack spacing={2} sx={{ mt: 2 }}>
            <FormControl>
              <FormLabel>Select Organization</FormLabel>
              <Select
                placeholder="Choose an organization..."
                value={selectedOrgId}
                onChange={(_, value) => setSelectedOrgId(value)}
              >
                {availableOrgs?.map(org => (
                  <Option key={org.id} value={org.id}>
                    {org.name}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <Alert color="neutral" size="sm">
              You&apos;ll receive GitHub webhook events from this organization. Events will be available in your
              connected MCP servers.
            </Alert>
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button variant="plain" onClick={() => setShowAddModal(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreateSubscription}
                loading={createSubscription.isPending}
                disabled={!selectedOrgId}
              >
                Subscribe
              </Button>
            </Box>
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default WebhookSubscriptions;

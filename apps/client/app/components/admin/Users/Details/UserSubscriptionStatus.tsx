import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useGetUserSubscriptions, useRemoveSubscription } from '@client/app/hooks/data/subscriptions';
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
  LinearProgress,
  IconButton,
  Tooltip,
} from '@mui/joy';
import PersonIcon from '@mui/icons-material/Person';
import GroupIcon from '@mui/icons-material/Group';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import EventIcon from '@mui/icons-material/Event';
import { CreditIcon } from '@client/app/components/svgs/icons/CreditIcon';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import dayjs from 'dayjs';
import React, { useState } from 'react';
import {
  isLiveStripeBilledSubscription,
  LIVE_STRIPE_SUBSCRIPTION_REMOVE_MESSAGE,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';
import EditCreditsModal from './EditCreditsModal';

type RemoveTarget = { subscriptionId: string; name: string; type: 'individual' | 'team' };

interface UserSubscriptionStatusProps {
  user: AdminUserListItem;
}

const UserSubscriptionStatus: React.FC<UserSubscriptionStatusProps> = ({ user }) => {
  const { data: subscriptionData, isLoading, error } = useGetUserSubscriptions(user.id);
  const removeSubscription = useRemoveSubscription();
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [editCreditsModalOpen, setEditCreditsModalOpen] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<{
    subscriptionId: string;
    type: 'individual' | 'team';
    name: string;
    currentCredits: number;
  } | null>(null);

  if (isLoading) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography color="danger">Failed to load subscription information</Typography>
        </CardContent>
      </Card>
    );
  }

  if (!subscriptionData) {
    return null;
  }

  const { individualSubscriptions, teamSubscriptions, userCredits } = subscriptionData;

  const getStatusColor = (status: string, canceledAt: Date | null) => {
    if (canceledAt) return 'warning';
    return status === 'active' ? 'success' : 'danger';
  };

  const handleRemoveSubscription = async (reason: string) => {
    if (!removeTarget) return;
    try {
      await removeSubscription.mutateAsync({ userId: user.id, subscriptionId: removeTarget.subscriptionId, reason });
      setRemoveTarget(null);
    } catch {
      // toast handled by the mutation
    }
  };

  const handleEditCredits = (
    subscriptionId: string,
    type: 'individual' | 'team',
    name: string,
    currentCredits: number
  ) => {
    setSelectedSubscription({ subscriptionId, type, name, currentCredits });
    setEditCreditsModalOpen(true);
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography level="title-lg" sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
          <CreditCardIcon />
          Subscription Status
        </Typography>

        <Stack spacing={3}>
          {/* User Credits */}
          <Box>
            <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <CreditIcon />
              User Credits: <strong>{userCredits.toLocaleString()}</strong>
            </Typography>
          </Box>

          <Divider />

          {/* Individual Subscriptions */}
          <Box>
            <Typography level="title-md" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <PersonIcon />
              Individual Subscriptions ({individualSubscriptions.length})
            </Typography>

            {individualSubscriptions.length === 0 ? (
              <Typography level="body-sm" color="neutral">
                No active individual subscriptions
              </Typography>
            ) : (
              <Stack spacing={2}>
                {individualSubscriptions.map(subscription => {
                  const effectiveCredits = subscription.effectiveCreditsPerCycle || subscription.planCredits || 0;
                  const hasCustomCredits = subscription.customCreditsPerCycle !== undefined;

                  return (
                    <Card key={subscription.id ?? subscription.subscriptionId} variant="soft">
                      <CardContent>
                        <Stack spacing={2}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <Box sx={{ flex: 1 }}>
                              <Typography level="body-md" sx={{ fontWeight: 'bold' }}>
                                {subscription.planName || 'Unknown Plan'}
                              </Typography>
                              <Typography level="body-sm" color="neutral">
                                {effectiveCredits.toLocaleString()} credits per billing cycle
                                {hasCustomCredits && ' (custom)'}
                              </Typography>
                              {hasCustomCredits && subscription.planCredits && (
                                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                  Default: {subscription.planCredits.toLocaleString()} credits
                                </Typography>
                              )}
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                              <Chip color={getStatusColor(subscription.status, subscription.canceledAt)} size="sm">
                                {subscription.canceledAt ? 'Canceling' : subscription.status}
                              </Chip>
                              {subscription.subscriptionId && (
                                <>
                                  <Tooltip title="Edit credits per cycle">
                                    <IconButton
                                      size="sm"
                                      variant="soft"
                                      color="primary"
                                      onClick={() =>
                                        handleEditCredits(
                                          subscription.subscriptionId!,
                                          'individual',
                                          subscription.planName || 'Unknown Plan',
                                          effectiveCredits
                                        )
                                      }
                                      data-testid={`edit-credits-${subscription.subscriptionId}`}
                                    >
                                      <EditIcon />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip
                                    title={
                                      isLiveStripeBilledSubscription(subscription)
                                        ? LIVE_STRIPE_SUBSCRIPTION_REMOVE_MESSAGE
                                        : 'Remove subscription'
                                    }
                                  >
                                    {/* A disabled button fires no hover events, so the span carries the tooltip. */}
                                    <span>
                                      <IconButton
                                        size="sm"
                                        variant="soft"
                                        color="danger"
                                        disabled={isLiveStripeBilledSubscription(subscription)}
                                        onClick={() =>
                                          setRemoveTarget({
                                            subscriptionId: subscription.subscriptionId!,
                                            name: subscription.planName || 'Unknown Plan',
                                            type: 'individual',
                                          })
                                        }
                                        data-testid={`remove-subscription-${subscription.subscriptionId}`}
                                      >
                                        <DeleteIcon />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                </>
                              )}
                            </Box>
                          </Box>

                          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                            <Typography level="body-sm" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <EventIcon sx={{ fontSize: '1rem' }} />
                              Period: {dayjs(subscription.periodStartsAt).format('MMM D, YYYY')} -{' '}
                              {dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}
                            </Typography>
                          </Box>

                          {subscription.canceledAt && (
                            <Typography level="body-sm" color="warning">
                              Canceled on {dayjs(subscription.canceledAt).format('MMM D, YYYY')} • Ends on{' '}
                              {dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}
                            </Typography>
                          )}
                        </Stack>
                      </CardContent>
                    </Card>
                  );
                })}
              </Stack>
            )}
          </Box>

          <Divider />

          {/* Team Subscriptions */}
          <Box>
            <Typography level="title-md" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <GroupIcon />
              Team Subscriptions ({teamSubscriptions.length})
            </Typography>

            {teamSubscriptions.length === 0 ? (
              <Typography level="body-sm" color="neutral">
                No active team subscriptions
              </Typography>
            ) : (
              <Stack spacing={2}>
                {teamSubscriptions.map(teamSub => {
                  const { organization, subscription } = teamSub;
                  const usedSeats = organization.users.length + 1; // +1 for the owner
                  const totalSeats = organization.seats;
                  const seatsUsagePercentage = (usedSeats / totalSeats) * 100;
                  const effectiveCredits =
                    subscription.effectiveCreditsPerCycle || subscription.defaultCreditsPerCycle || 0;
                  const hasCustomCredits = subscription.customCreditsPerCycle !== undefined;

                  return (
                    <Card key={organization.id} variant="soft">
                      <CardContent>
                        <Stack spacing={2}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <Box sx={{ flex: 1 }}>
                              <Typography level="body-md" sx={{ fontWeight: 'bold' }}>
                                {organization.name}
                              </Typography>
                              <Typography level="body-sm" color="neutral">
                                Team Plan • {subscription.quantity} seats
                              </Typography>
                              <Typography level="body-sm" color="neutral">
                                {effectiveCredits.toLocaleString()} credits per cycle
                                {hasCustomCredits && ' (custom)'}
                              </Typography>
                              {hasCustomCredits && subscription.defaultCreditsPerCycle && (
                                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                  Default: {subscription.defaultCreditsPerCycle.toLocaleString()} credits
                                </Typography>
                              )}
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                              <Chip color={getStatusColor(subscription.status, subscription.canceledAt)} size="sm">
                                {subscription.canceledAt ? 'Canceling' : subscription.status}
                              </Chip>
                              {subscription.subscriptionId && (
                                <>
                                  <Tooltip title="Edit credits per cycle">
                                    <IconButton
                                      size="sm"
                                      variant="soft"
                                      color="primary"
                                      onClick={() =>
                                        handleEditCredits(
                                          subscription.subscriptionId!,
                                          'team',
                                          organization.name,
                                          effectiveCredits
                                        )
                                      }
                                      data-testid={`edit-credits-${subscription.subscriptionId}`}
                                    >
                                      <EditIcon />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip
                                    title={
                                      isLiveStripeBilledSubscription(subscription)
                                        ? LIVE_STRIPE_SUBSCRIPTION_REMOVE_MESSAGE
                                        : 'Remove subscription'
                                    }
                                  >
                                    {/* A disabled button fires no hover events, so the span carries the tooltip. */}
                                    <span>
                                      <IconButton
                                        size="sm"
                                        variant="soft"
                                        color="danger"
                                        disabled={isLiveStripeBilledSubscription(subscription)}
                                        onClick={() =>
                                          setRemoveTarget({
                                            subscriptionId: subscription.subscriptionId!,
                                            name: organization.name,
                                            type: 'team',
                                          })
                                        }
                                        data-testid={`remove-subscription-${subscription.subscriptionId}`}
                                      >
                                        <DeleteIcon />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                </>
                              )}
                            </Box>
                          </Box>

                          <Box>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                              <Typography level="body-sm">
                                Seat Usage: {usedSeats} / {totalSeats}
                              </Typography>
                              <Typography level="body-sm" color="neutral">
                                {((usedSeats / totalSeats) * 100).toFixed(0)}% used
                              </Typography>
                            </Box>
                            <LinearProgress
                              determinate
                              value={seatsUsagePercentage}
                              color={seatsUsagePercentage > 90 ? 'warning' : 'primary'}
                            />
                          </Box>

                          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                            <Typography level="body-sm" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <EventIcon sx={{ fontSize: '1rem' }} />
                              Period: {dayjs(subscription.periodStartsAt).format('MMM D, YYYY')} -{' '}
                              {dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}
                            </Typography>
                          </Box>

                          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                            <Typography level="body-sm" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <CreditIcon sx={{ fontSize: '1rem' }} />
                              Org Credits: {organization.currentCredits.toLocaleString()}
                            </Typography>
                          </Box>

                          {subscription.canceledAt && (
                            <Typography level="body-sm" color="warning">
                              Canceled on {dayjs(subscription.canceledAt).format('MMM D, YYYY')} • Ends on{' '}
                              {dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}
                            </Typography>
                          )}
                        </Stack>
                      </CardContent>
                    </Card>
                  );
                })}
              </Stack>
            )}
          </Box>
        </Stack>
      </CardContent>

      <ActionDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title={`Remove ${removeTarget?.type ?? ''} subscription`}
        description={`Deletes the "${removeTarget?.name ?? ''}" subscription record for ${user.name}. This cannot be undone.`}
        reasonPresets={ADMIN_REASON_PRESETS.subscriptionRemove}
        confirmLabel="Remove subscription"
        tone="danger"
        pending={removeSubscription.isPending}
        onConfirm={handleRemoveSubscription}
        data-testid="remove-subscription-dialog"
      />

      {/* Edit Credits Modal */}
      {selectedSubscription && (
        <EditCreditsModal
          open={editCreditsModalOpen}
          onClose={() => {
            setEditCreditsModalOpen(false);
            setSelectedSubscription(null);
          }}
          userId={user.id}
          subscriptionId={selectedSubscription.subscriptionId}
          subscriptionName={selectedSubscription.name}
          subscriptionType={selectedSubscription.type}
          currentCreditsPerCycle={selectedSubscription.currentCredits}
        />
      )}
    </Card>
  );
};

export default UserSubscriptionStatus;

import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGrantSubscription } from '@client/app/hooks/data/subscriptions';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { useTeamCreditsPerSeat, useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Stack,
  FormControl,
  FormLabel,
  Select,
  Option,
  Input,
  Button,
  Divider,
  IconButton,
  Box,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import React, { useState, useMemo } from 'react';
import UserSelector from '@client/app/components/admin/shared/UserSelector';
import { ReasonPicker } from '@client/app/components/admin/shared/ReasonPicker';
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from '@client/app/components/admin/shared/adminReason';

interface GrantSubscriptionModalProps {
  user: AdminUserListItem;
  open: boolean;
  onClose: () => void;
}

const GrantSubscriptionModal: React.FC<GrantSubscriptionModalProps> = ({ user, open, onClose }) => {
  const { minSeats, maxSeats } = useTeamSeatLimits();
  const creditsPerSeat = useTeamCreditsPerSeat();
  const [subscriptionType, setSubscriptionType] = useState<'individual' | 'team'>('individual');
  const [priceId, setPriceId] = useState<string>('');
  // Clamped on read: the initial pick is taken before the seat settings load (see CreateTeamModal).
  const [requestedSeats, setSeats] = useState(minSeats);
  const seats = Math.min(Math.max(requestedSeats, minSeats), maxSeats);
  const [organizationName, setOrganizationName] = useState('');
  const [durationMonths, setDurationMonths] = useState(1);
  const [billingOwnerId, setBillingOwnerId] = useState<string | null>(null);
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);

  const grantSubscription = useGrantSubscription();
  const plans = useGetSubscriptionPlans();

  const availableIndividualPlans = useMemo(() => {
    if (!plans.data) return [];
    return SUBSCRIPTION_PLANS.filter(plan => plans.data.some(p => p.id === plan.priceId && p.active));
  }, [plans.data]);

  const handleSubmit = async () => {
    if (subscriptionType === 'individual') {
      if (!priceId) return;

      await grantSubscription.mutateAsync({
        userId: user.id,
        subscriptionType: 'individual',
        priceId,
        durationMonths,
        reason: composeAdminReason(reason),
      });
    } else {
      if (!organizationName.trim()) return;

      await grantSubscription.mutateAsync({
        userId: user.id,
        subscriptionType: 'team',
        seats,
        organizationName: organizationName.trim(),
        durationMonths,
        billingOwnerId: billingOwnerId || undefined,
        reason: composeAdminReason(reason),
      });
    }

    onClose();
    resetForm();
  };

  const resetForm = () => {
    setSubscriptionType('individual');
    setPriceId('');
    setSeats(minSeats);
    setOrganizationName('');
    setDurationMonths(1);
    setBillingOwnerId(null);
    setReason(EMPTY_ADMIN_REASON);
  };

  const handleClose = () => {
    onClose();
    resetForm();
  };

  const selectedPlan = availableIndividualPlans.find(plan => plan.priceId === priceId);
  const isSelectionValid =
    subscriptionType === 'individual' ? !!priceId : !!organizationName.trim() && seats >= minSeats;
  const isFormValid = isSelectionValid && isAdminReasonComplete(reason);

  const calculateCredits = () => {
    if (subscriptionType === 'individual' && selectedPlan) {
      return selectedPlan.credits * durationMonths;
    } else if (subscriptionType === 'team') {
      return seats * creditsPerSeat * durationMonths;
    }
    return 0;
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog
        sx={{
          width: '100%',
          maxWidth: '500px',
          maxHeight: '90vh',
          overflowY: 'auto',
          // On mobile, the default center layout (top:50% + translateY(-50%)) causes the modal
          // to jump when the virtual keyboard opens and shifts the visual viewport height.
          // Anchoring to a fixed top position with only horizontal centering prevents this.
          '@media (pointer: coarse)': {
            top: '5%',
            transform: 'translateX(-50%)',
          },
        }}
      >
        <ModalClose />

        <Typography level="h3" sx={{ mb: 2 }}>
          Grant Subscription to {user.name}
        </Typography>

        <Stack spacing={3}>
          <FormControl>
            <FormLabel>Subscription Type</FormLabel>
            <Select
              value={subscriptionType}
              onChange={(_, value) => setSubscriptionType(value as 'individual' | 'team')}
            >
              <Option value="individual">Individual Plan</Option>
              <Option value="team">Team Plan</Option>
            </Select>
          </FormControl>

          {subscriptionType === 'individual' && (
            <FormControl>
              <FormLabel>Plan</FormLabel>
              <Select
                placeholder="Select a plan"
                value={priceId}
                onChange={(_, value) => setPriceId(value || '')}
                disabled={availableIndividualPlans.length === 0}
              >
                {availableIndividualPlans.map(plan => (
                  <Option key={plan.priceId} value={plan.priceId}>
                    <Box>
                      <Typography level="body-md">{plan.name}</Typography>
                      <Typography level="body-sm" color="neutral">
                        {plan.credits.toLocaleString()} credits • {plan.interval}
                      </Typography>
                    </Box>
                  </Option>
                ))}
              </Select>
              {availableIndividualPlans.length === 0 && (
                <Typography level="body-sm" color="warning">
                  No active individual plans available
                </Typography>
              )}
            </FormControl>
          )}

          {subscriptionType === 'team' && (
            <>
              <FormControl>
                <FormLabel>Organization Name</FormLabel>
                <Input
                  placeholder="Enter organization name"
                  value={organizationName}
                  onChange={e => setOrganizationName(e.target.value)}
                />
              </FormControl>

              <UserSelector
                label="Billing Owner"
                value={billingOwnerId}
                onChange={setBillingOwnerId}
                placeholder="Select billing owner (optional)"
                helperText="The user responsible for billing. Defaults to the target user if not specified."
              />

              <FormControl>
                <FormLabel>Number of Seats</FormLabel>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <IconButton
                    variant="soft"
                    color="neutral"
                    disabled={seats <= minSeats}
                    onClick={() => setSeats(Math.max(minSeats, seats - 1))}
                  >
                    <RemoveIcon />
                  </IconButton>
                  <Typography level="h4" sx={{ minWidth: '60px', textAlign: 'center' }}>
                    {seats}
                  </Typography>
                  <IconButton
                    variant="soft"
                    color="neutral"
                    disabled={seats >= maxSeats}
                    onClick={() => setSeats(Math.min(maxSeats, seats + 1))}
                  >
                    <AddIcon />
                  </IconButton>
                </Box>
                <Typography level="body-sm" color="neutral">
                  Min: {minSeats}, Max: {maxSeats}
                </Typography>
              </FormControl>
            </>
          )}

          <FormControl>
            <FormLabel>Duration</FormLabel>
            <Select value={durationMonths} onChange={(_, value) => setDurationMonths(value || 1)}>
              {[1, 2, 3, 6, 12].map(months => (
                <Option key={months} value={months}>
                  {months} month{months > 1 ? 's' : ''}
                </Option>
              ))}
            </Select>
          </FormControl>

          <ReasonPicker
            presets={ADMIN_REASON_PRESETS.subscriptionGrant}
            value={reason}
            onChange={setReason}
            data-testid="grant-subscription-reason-input"
          />

          {isSelectionValid && (
            <Box sx={{ p: 2, backgroundColor: 'background.level1', borderRadius: 'md' }}>
              <Typography level="body-sm" color="primary" sx={{ fontWeight: 'bold' }}>
                Credits to be granted: {calculateCredits().toLocaleString()}
              </Typography>
            </Box>
          )}

          <Divider />

          <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
            <Button variant="outlined" color="neutral" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleSubmit}
              loading={grantSubscription.isPending}
              disabled={!isFormValid || grantSubscription.isPending}
            >
              Grant Subscription
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default GrantSubscriptionModal;

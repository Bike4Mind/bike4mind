import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGrantSubscription } from '@client/app/hooks/data/subscriptions';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { useTeamCreditsPerSeat, useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { Typography, Stack, FormControl, FormLabel, Select, Option, Input, IconButton, Box } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import React, { useState, useMemo } from 'react';
import UserSelector from '@client/app/components/admin/shared/UserSelector';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ChangePreview } from '@client/app/components/admin/shared/ChangePreview';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';

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

  const grantSubscription = useGrantSubscription();
  const plans = useGetSubscriptionPlans();

  const availableIndividualPlans = useMemo(() => {
    if (!plans.data) return [];
    return SUBSCRIPTION_PLANS.filter(plan => plans.data.some(p => p.id === plan.priceId && p.active));
  }, [plans.data]);

  const resetForm = () => {
    setSubscriptionType('individual');
    setPriceId('');
    setSeats(minSeats);
    setOrganizationName('');
    setDurationMonths(1);
    setBillingOwnerId(null);
  };

  const handleClose = () => {
    onClose();
    resetForm();
  };

  // A rejection propagates to ActionDialog, which keeps the dialog open; the hook has already toasted.
  const handleConfirm = async (reason: string) => {
    if (subscriptionType === 'individual') {
      if (!priceId) return;
      await grantSubscription.mutateAsync({
        userId: user.id,
        subscriptionType: 'individual',
        priceId,
        durationMonths,
        reason,
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
        reason,
      });
    }
    handleClose();
  };

  const selectedPlan = availableIndividualPlans.find(plan => plan.priceId === priceId);
  const grantedCredits = ((): number => {
    if (subscriptionType === 'team') return seats * creditsPerSeat * durationMonths;
    return selectedPlan ? selectedPlan.credits * durationMonths : 0;
  })();

  const blockedReason = ((): string | null => {
    if (subscriptionType === 'individual') return priceId ? null : 'Select a plan to grant.';
    return organizationName.trim() ? null : 'Enter an organization name.';
  })();

  const isIndividual = subscriptionType === 'individual';
  const afterPlan = isIndividual ? (selectedPlan?.name ?? 'No plan') : `Team plan, ${seats} seats`;

  return (
    <ActionDialog
      open={open}
      onClose={handleClose}
      title={`Grant subscription to ${user.name}`}
      description="Creates an admin-granted subscription and adds its credits now. It is not billed through Stripe."
      reasonPresets={ADMIN_REASON_PRESETS.subscriptionGrant}
      confirmLabel={`Grant ${durationMonths} month${durationMonths > 1 ? 's' : ''}`}
      onConfirm={handleConfirm}
      blockedReason={blockedReason}
      pending={grantSubscription.isPending}
      data-testid="grant-subscription-dialog"
      testIds={{ reason: 'grant-subscription-reason-input' }}
    >
      <Stack spacing={2}>
        <FormControl>
          <FormLabel>Subscription Type</FormLabel>
          <Select
            value={subscriptionType}
            onChange={(_, value) => setSubscriptionType(value === 'team' ? 'team' : 'individual')}
            data-testid="grant-subscription-type-select"
          >
            <Option value="individual">Individual Plan</Option>
            <Option value="team">Team Plan</Option>
          </Select>
        </FormControl>

        {isIndividual && (
          <FormControl>
            <FormLabel>Plan</FormLabel>
            <Select
              placeholder="Select a plan"
              value={priceId}
              onChange={(_, value) => setPriceId(value || '')}
              disabled={availableIndividualPlans.length === 0}
              data-testid="grant-subscription-plan-select"
            >
              {availableIndividualPlans.map(plan => (
                <Option key={plan.priceId} value={plan.priceId}>
                  <Box>
                    <Typography level="body-md">{plan.name}</Typography>
                    <Typography level="body-sm" color="neutral">
                      {plan.credits.toLocaleString()} credits {'\u2022'} {plan.interval}
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

        {!isIndividual && (
          <>
            <FormControl>
              <FormLabel>Organization Name</FormLabel>
              <Input
                placeholder="Enter organization name"
                value={organizationName}
                onChange={e => setOrganizationName(e.target.value)}
                slotProps={{ input: { 'data-testid': 'grant-subscription-org-name-input' } }}
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
                  aria-label="Fewer seats"
                  disabled={seats <= minSeats}
                  onClick={() => setSeats(Math.max(minSeats, seats - 1))}
                >
                  <RemoveIcon />
                </IconButton>
                <Typography
                  level="h4"
                  sx={{ minWidth: '60px', textAlign: 'center' }}
                  data-testid="grant-subscription-seats"
                >
                  {seats}
                </Typography>
                <IconButton
                  variant="soft"
                  color="neutral"
                  aria-label="More seats"
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
          <Select
            value={durationMonths}
            onChange={(_, value) => setDurationMonths(value || 1)}
            data-testid="grant-subscription-duration-select"
          >
            {[1, 2, 3, 6, 12].map(months => (
              <Option key={months} value={months}>
                {months} month{months > 1 ? 's' : ''}
              </Option>
            ))}
          </Select>
        </FormControl>

        <ChangePreview
          before={isIndividual ? `${(user.currentCredits ?? 0).toLocaleString()} credits` : 'No plan'}
          after={
            <>
              {afterPlan}
              <Typography level="body-sm" component="div" sx={{ color: 'admin.inkMuted' }}>
                +{grantedCredits.toLocaleString()} credits
              </Typography>
            </>
          }
          delta={{ label: `+${grantedCredits.toLocaleString()} credits`, tone: 'good' }}
          data-testid="grant-subscription-preview"
        />
      </Stack>
    </ActionDialog>
  );
};

export default GrantSubscriptionModal;

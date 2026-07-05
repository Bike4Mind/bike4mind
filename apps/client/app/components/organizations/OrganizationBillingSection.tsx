import { IOrganizationDocument } from '@bike4mind/common';
import { useStripePortal, useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import {
  useGetSubscriptionsByOwner,
  useSubscribeTeamPlan,
  useUpdateSubscriptionSeats,
} from '@client/app/hooks/data/subscriptions';
import {
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
} from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType, ISubscription } from '@client/lib/subscriptions/types';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import GroupIcon from '@mui/icons-material/Group';
import PaymentIcon from '@mui/icons-material/Payment';
import EventIcon from '@mui/icons-material/Event';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
  Divider,
  Card,
  CardContent,
  LinearProgress,
} from '@mui/joy';
import dayjs from 'dayjs';
import { useState, useEffect, useMemo } from 'react';

type OrganizationBillingSectionProps = {
  organization: IOrganizationDocument;
};

const SubscriptionModal = ({
  open,
  onClose,
  onSubmit,
  loading,
  organization,
  subscription,
  pricePerSeat,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (seats: number) => void;
  loading: boolean;
  organization: IOrganizationDocument;
  subscription?: ISubscription;
  pricePerSeat: number;
}) => {
  const minimumSeats = Math.max(ORGANIZATION_SUBSCRIPTION_MIN_SEATS, organization.users.length + 1);
  // Initialize with current seats if it's an existing subscription, otherwise use minimum seats
  const [seats, setSeats] = useState(subscription ? organization.seats : minimumSeats);
  const updateSeats = useUpdateSubscriptionSeats();

  // Update seats when organization.seats changes
  useEffect(() => {
    if (subscription) {
      setSeats(organization.seats);
    }
  }, [organization.seats, subscription]);

  const handleClose = () => {
    // Reset to current seats if it's an existing subscription, otherwise minimum seats
    setSeats(subscription ? organization.seats : minimumSeats);
    onClose();
  };

  const handleSubmit = async () => {
    if (!subscription) {
      onSubmit(seats);
      return;
    }

    try {
      await updateSeats.mutateAsync({
        organizationId: organization.id,
        seats,
      });
      handleClose();
    } catch (error) {
      // Error will be handled by the mutation
    }
  };

  const handleIncreaseSeats = () => {
    setSeats(prev => (prev < ORGANIZATION_SUBSCRIPTION_MAX_SEATS ? prev + 1 : prev));
  };

  const handleDecreaseSeats = () => {
    setSeats(prev => (prev > minimumSeats ? prev - 1 : prev));
  };

  // Calculate if we're decreasing seats from current allocation
  const isDecreasingSeats = subscription && seats < organization.seats;

  // Add warning message for max seats
  const isAtMaxSeats = seats >= ORGANIZATION_SUBSCRIPTION_MAX_SEATS;

  const renderPrice = (price: number) => {
    return `$${price}`;
  };

  return (
    <Modal open={open} onClose={handleClose} className="organization-billing-modal">
      <ModalDialog sx={{ gap: '30px', width: '100%' }} maxWidth="560px" className="organization-billing-modal-dialog">
        <ModalClose className="organization-billing-modal-close" />

        <Typography level="h3" fontWeight="lg" className="organization-billing-modal-title">
          {subscription ? 'Update Team Seats' : 'Subscribe to Team Plan'}
        </Typography>

        <Box className="organization-billing-container">
          <Typography level="body-md" color="neutral" mb={3} className="organization-billing-modal-description">
            {subscription
              ? 'Add more seats to your team subscription. Changes will be reflected in your next billing cycle.'
              : 'Choose the number of seats for your team subscription.'}
          </Typography>

          <FormControl className="organization-billing-seats-control">
            <FormLabel className="organization-billing-seats-label">Number of Seats</FormLabel>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                mt: 1,
                p: 2,
                border: '1px solid',
                borderColor: 'neutral.200',
                borderRadius: 'md',
              }}
              className="organization-billing-seats-container"
            >
              <IconButton
                variant="soft"
                color="neutral"
                disabled={seats <= minimumSeats}
                onClick={handleDecreaseSeats}
                size="lg"
                className="organization-billing-seats-decrease"
              >
                <RemoveIcon />
              </IconButton>
              <Typography
                level="h4"
                sx={{ minWidth: '60px', textAlign: 'center' }}
                className="organization-billing-seats-value"
              >
                {seats}
              </Typography>
              <IconButton
                variant="soft"
                color="neutral"
                onClick={handleIncreaseSeats}
                size="lg"
                disabled={isAtMaxSeats}
                className="organization-billing-seats-increase"
              >
                <AddIcon />
              </IconButton>
            </Box>
          </FormControl>

          <Card variant="soft" sx={{ mt: 3 }} className="organization-billing-price-card">
            <CardContent className="organization-billing-price-content">
              <Stack spacing={2} className="organization-billing-price-stack">
                <Box
                  sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  className="organization-billing-price-row"
                >
                  <Typography level="body-md" className="organization-billing-price-label">
                    Price per seat
                  </Typography>
                  <Typography level="body-md" className="organization-billing-price-value">
                    {renderPrice(pricePerSeat)}/month
                  </Typography>
                </Box>
                <Box
                  sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  className="organization-billing-seats-row"
                >
                  <Typography level="body-md" className="organization-billing-seats-label">
                    Number of seats
                  </Typography>
                  <Typography level="body-md" className="organization-billing-seats-value">
                    × {seats}
                  </Typography>
                </Box>
                {subscription && (
                  <Box
                    sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    className="organization-billing-change-row"
                  >
                    <Typography level="body-md" className="organization-billing-change-label">
                      Change in seats
                    </Typography>
                    <Typography
                      level="body-md"
                      color={isDecreasingSeats ? 'warning' : 'success'}
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                      className="organization-billing-change-value"
                    >
                      {isDecreasingSeats ? '-' : '+'}
                      {Math.abs(seats - organization.seats)} seats
                    </Typography>
                  </Box>
                )}
                <Divider className="organization-billing-price-divider" />
                <Box
                  sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  className="organization-billing-total-row"
                >
                  <Typography level="title-md" className="organization-billing-total-label">
                    Total Price
                  </Typography>
                  <Typography level="title-md" className="organization-billing-total-value">
                    {renderPrice(seats * pricePerSeat)}/month
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>

          {isDecreasingSeats && (
            <Typography level="body-sm" mt={2} color="warning" className="organization-billing-warning">
              Note: Decreasing seats will not affect your current team members, but you won&apos;t be able to add new
              members until you increase seats again.
            </Typography>
          )}

          {isAtMaxSeats && (
            <Typography level="body-sm" mt={2} color="warning">
              Maximum number of seats ({ORGANIZATION_SUBSCRIPTION_MAX_SEATS}) reached.
            </Typography>
          )}

          <Typography level="body-sm" mt={2} color="warning">
            {organization.users.length + 1 > ORGANIZATION_SUBSCRIPTION_MIN_SEATS ? (
              `Minimum seats required: ${organization.users.length + 1} (current team size)`
            ) : (
              <>
                Minimum seats required: {ORGANIZATION_SUBSCRIPTION_MIN_SEATS}
                {organization.users.length + 1 < ORGANIZATION_SUBSCRIPTION_MIN_SEATS && (
                  <Typography component="span" sx={{ display: 'block' }} color="neutral">
                    Your team currently has {organization.users.length + 1}{' '}
                    {organization.users.length === 0 ? 'member' : 'members'}
                  </Typography>
                )}
              </>
            )}
          </Typography>

          {updateSeats.error && (
            <Typography level="body-sm" color="danger" mt={2}>
              {updateSeats.error.message}
            </Typography>
          )}
        </Box>

        <Box
          sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', mt: 2 }}
          className="organization-billing-actions"
        >
          <Button
            variant="outlined"
            color="neutral"
            onClick={handleClose}
            size="lg"
            className="organization-billing-cancel-button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={loading || updateSeats.isPending}
            size="lg"
            className="organization-billing-submit-button"
          >
            {subscription ? 'Update Seats' : 'Subscribe'}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

const OrganizationBillingSection = ({ organization }: OrganizationBillingSectionProps) => {
  const [isSubscriptionModalOpen, setIsSubscriptionModalOpen] = useState(false);
  const subscriptions = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id);
  const stripePortal = useStripePortal();
  const subscribeTeamPlan = useSubscribeTeamPlan();
  const subscription = subscriptions.data?.[0];
  const plans = useGetSubscriptionPlans();

  // Get the price per seat from Stripe
  const pricePerSeat = useMemo(() => {
    if (!plans.data) return null;
    const plan = plans.data.find(p => p.id === ORGANIZATION_SUBSCRIPTION_PRICE_ID);
    return plan?.unit_amount ? plan.unit_amount / 100 : null;
  }, [plans.data]);

  const handleSubscribe = async (seats: number) => {
    const result = await subscribeTeamPlan.mutateAsync({
      priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
      quantity: seats,
      organizationId: organization.id,
      callbackUrl: window.location.origin,
    });
    if (result.sessionUrl) {
      // Store the return path before navigating so the router can redirect back after Stripe.
      // Replace the current history entry with "/" so the browser Back button returns to root
      // (served by CloudFront) rather than the org billing path (which CloudFront 403s).
      sessionStorage.setItem('__stripe_return', `${window.location.pathname}?tab=billing`);
      window.history.replaceState(null, '', '/');
      window.location.href = result.sessionUrl;
    }
  };

  // Show loading state if either subscriptions or prices are loading
  if (subscriptions.isPending || plans.isPending) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100%">
        <CircularProgress />
      </Box>
    );
  }

  // Don't show subscription modal if price isn't loaded
  const handleOpenSubscriptionModal = () => {
    if (pricePerSeat !== null) {
      setIsSubscriptionModalOpen(true);
    }
  };

  const usedSeats = organization.users.length + 1;
  const totalSeats = organization.seats;
  const seatsUsagePercentage = (usedSeats / totalSeats) * 100;

  // Render price, showing a spinner while it loads
  const renderPrice = (price: number | null) => {
    if (price === null) {
      return <CircularProgress size="sm" />;
    }
    return `$${price}`;
  };

  return (
    <Box className="organization-billing-usage-container">
      <Box
        sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}
        className="organization-billing-header"
      >
        <Typography level="h2" fontWeight="lg" className="organization-billing-title">
          Billing & Subscription
        </Typography>
        {subscription && (
          <Button
            variant="outlined"
            color="primary"
            onClick={() => {
              // Store the return path synchronously before mutating so it's set even if the
              // browser starts navigation before the async onSuccess callback fires.
              // Also replace the current history entry with "/" so that the browser Back button
              // returns to the root (served by CloudFront) rather than the org billing path
              // (which CloudFront 403s on staging/production).
              sessionStorage.setItem('__stripe_return', `${window.location.pathname}?tab=billing`);
              window.history.replaceState(null, '', '/');
              stripePortal.mutate({ ownerType: SubscriptionOwnerType.Organization, ownerId: organization.id });
            }}
            loading={stripePortal.isPending}
            startDecorator={<PaymentIcon />}
            className="organization-billing-portal-button"
          >
            Billing Portal
          </Button>
        )}
      </Box>

      <Stack spacing={4} className="organization-billing-content">
        {/* Current Plan Overview */}
        <Card variant="outlined" className="organization-billing-plan-card">
          <CardContent className="organization-billing-plan-content">
            <Stack spacing={3} className="organization-billing-plan-stack">
              <Box
                sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
                className="organization-billing-plan-header"
              >
                <Box>
                  <Typography level="title-lg" sx={{ mb: 1 }} className="organization-billing-plan-title">
                    {!!subscription ? 'Team Plan' : 'No Active Subscription'}
                  </Typography>
                  <Typography level="body-md" color="neutral" className="organization-billing-plan-price">
                    {subscription ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        {renderPrice(pricePerSeat)} per seat/month
                      </Box>
                    ) : (
                      'Subscribe to access team features'
                    )}
                  </Typography>
                </Box>
                {subscription ? (
                  <Box sx={{ textAlign: 'right' }} className="organization-billing-plan-status">
                    <Typography
                      level="body-md"
                      startDecorator={subscription.canceledAt ? <CancelIcon /> : <CheckCircleIcon />}
                      color={subscription.canceledAt ? 'warning' : 'success'}
                      sx={{ mb: 1 }}
                      className="organization-billing-plan-state"
                    >
                      {subscription.canceledAt ? 'Canceled' : 'Active'}
                    </Typography>
                    <Typography
                      level="body-sm"
                      color="neutral"
                      startDecorator={<EventIcon sx={{ fontSize: '1rem' }} />}
                      className="organization-billing-plan-renewal"
                    >
                      {subscription.canceledAt
                        ? `Ends on ${dayjs(subscription.periodEndsAt).format('MMMM D, YYYY')}`
                        : `Renews on ${dayjs(subscription.periodEndsAt).format('MMMM D, YYYY')}`}
                    </Typography>
                  </Box>
                ) : (
                  <Button
                    variant="solid"
                    color="primary"
                    onClick={handleOpenSubscriptionModal}
                    loading={subscribeTeamPlan.isPending}
                    disabled={pricePerSeat === null}
                    className="organization-billing-subscribe-button"
                  >
                    Subscribe Now
                  </Button>
                )}
              </Box>

              {subscription && (
                <>
                  <Divider className="organization-billing-plan-divider" />
                  <Box>
                    <Box
                      sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}
                      className="organization-billing-usage-header"
                    >
                      <Typography
                        level="body-md"
                        startDecorator={<GroupIcon />}
                        className="organization-billing-usage-title"
                      >
                        Team Seats Usage
                      </Typography>
                      <Typography level="body-md" className="organization-billing-usage-value">
                        {usedSeats} / {totalSeats} seats used
                      </Typography>
                    </Box>
                    <Box sx={{ position: 'relative' }} className="organization-billing-usage-progress-container">
                      <LinearProgress
                        determinate
                        value={seatsUsagePercentage}
                        color={seatsUsagePercentage > 90 ? 'warning' : 'primary'}
                        className="organization-billing-usage-progress"
                      />
                    </Box>
                    <Box
                      sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}
                      className="organization-billing-usage-footer"
                    >
                      <Typography level="body-sm" color="neutral" className="organization-billing-usage-available">
                        {totalSeats - usedSeats} seats available
                      </Typography>
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        onClick={handleOpenSubscriptionModal}
                        startDecorator={<AddIcon />}
                        className="organization-billing-manage-button"
                      >
                        Manage Seats
                      </Button>
                    </Box>
                  </Box>
                </>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* Billing History - Placeholder for future implementation */}
        {subscription && (
          <Card variant="outlined" className="organization-billing-history-card">
            <CardContent className="organization-billing-history-content">
              <Typography level="title-lg" sx={{ mb: 2 }} className="organization-billing-history-title">
                Recent Activity
              </Typography>
              <Typography level="body-md" color="neutral" className="organization-billing-history-description">
                View your billing history and download invoices in the billing portal.
              </Typography>
            </CardContent>
          </Card>
        )}
      </Stack>

      {pricePerSeat !== null && (
        <SubscriptionModal
          open={isSubscriptionModalOpen}
          onClose={() => setIsSubscriptionModalOpen(false)}
          onSubmit={handleSubscribe}
          loading={subscribeTeamPlan.isPending}
          organization={organization}
          subscription={subscription}
          pricePerSeat={pricePerSeat}
        />
      )}
    </Box>
  );
};

export default OrganizationBillingSection;

import { useSubscribeTeamPlan, useCreateTeamDev } from '@client/app/hooks/data/subscriptions';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Skeleton,
  Typography,
} from '@mui/joy';
import { useState, useRef } from 'react';
import { create } from 'zustand';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useMemo } from 'react';

const isDevelopment = process.env.NODE_ENV === 'development';

export const useCreateTeamModal = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
}>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

const CreateTeamModal = () => {
  const { isOpen, close } = useCreateTeamModal();
  const [teamName, setTeamName] = useState('');
  const [teamSize, setTeamSize] = useState(ORGANIZATION_SUBSCRIPTION_MIN_SEATS);
  const subscribeTeamPlan = useSubscribeTeamPlan();
  const createTeamDev = useCreateTeamDev();
  const plans = useGetSubscriptionPlans();
  // mutation.isPending can't stop a second click fired before React re-renders; this ref
  // is checked synchronously so a rapid double-click can't slip both calls through.
  const submittingRef = useRef(false);

  const pricePerSeat = useMemo(() => {
    if (!plans.data) return 0;
    const plan = plans.data.find(p => p.id === ORGANIZATION_SUBSCRIPTION_PRICE_ID);
    return plan?.unit_amount ? plan.unit_amount / 100 : 0;
  }, [plans.data]);

  const handleClose = () => {
    setTeamName('');
    setTeamSize(ORGANIZATION_SUBSCRIPTION_MIN_SEATS);
    close();
  };

  const handleIncreaseTeamSize = () => {
    setTeamSize(prev => (prev < ORGANIZATION_SUBSCRIPTION_MAX_SEATS ? prev + 1 : prev));
  };

  const handleDecreaseTeamSize = () => {
    setTeamSize(prev => (prev > ORGANIZATION_SUBSCRIPTION_MIN_SEATS ? prev - 1 : prev));
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      if (isDevelopment) {
        // In development, bypass Stripe and create organization directly
        await createTeamDev.mutateAsync({
          name: teamName,
          seats: teamSize,
        });
        handleClose();
      } else {
        // In production, use the normal Stripe flow
        const { sessionUrl } = await subscribeTeamPlan.mutateAsync({
          priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
          quantity: teamSize,
          organizationData: {
            name: teamName,
          },
          callbackUrl: window.location.href,
        });
        window.location.href = sessionUrl;
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const isLoading = !isDevelopment && (plans.isLoading || !plans.data);
  const hasError = !isDevelopment && plans.isError;
  const isSubmitting = isDevelopment ? createTeamDev.isPending : subscribeTeamPlan.isPending;

  return (
    <Modal open={isOpen} onClose={handleClose} className="create-team-modal">
      <ModalDialog sx={{ gap: '30px', width: '100%' }} maxWidth="460px" className="create-team-modal-dialog">
        <ModalClose className="create-team-modal-close" />

        <Typography level="h4" fontWeight="normal" className="create-team-modal-title">
          Create New Team {isDevelopment && '(Dev Mode)'}
        </Typography>

        <FormControl className="create-team-form-control">
          <FormLabel className="create-team-form-label">Team Name</FormLabel>
          <Input
            placeholder="Enter team name"
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            disabled={isLoading || hasError}
            className="create-team-name-input"
          />
        </FormControl>

        <FormControl>
          <FormLabel className="create-team-form-label">Team Size</FormLabel>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }} className="create-team-size-control">
            <IconButton
              variant="outlined"
              color="neutral"
              disabled={teamSize <= ORGANIZATION_SUBSCRIPTION_MIN_SEATS || isLoading || hasError}
              onClick={handleDecreaseTeamSize}
              className="create-team-size-decrease"
            >
              <RemoveIcon />
            </IconButton>
            <Typography sx={{ minWidth: '40px', textAlign: 'center' }} className="create-team-size-value">
              {teamSize}
            </Typography>
            <IconButton
              variant="outlined"
              color="neutral"
              onClick={handleIncreaseTeamSize}
              disabled={isLoading || hasError || teamSize >= ORGANIZATION_SUBSCRIPTION_MAX_SEATS}
              className="create-team-size-increase"
            >
              <AddIcon />
            </IconButton>
          </Box>
          <Typography level="body-xs" sx={{ mt: 0.5 }} className="create-team-size-note">
            Team size must be between {ORGANIZATION_SUBSCRIPTION_MIN_SEATS} and {ORGANIZATION_SUBSCRIPTION_MAX_SEATS}{' '}
            members
          </Typography>
          <Box sx={{ mt: 1 }} className="create-team-price-container">
            {isLoading ? (
              <Skeleton variant="text" width={140} level="body-sm" className="create-team-price-loading">
                Total Price: $XXX/month
              </Skeleton>
            ) : hasError ? (
              <Typography level="body-sm" color="danger" className="create-team-price-error">
                Error loading price. Please try again later.
              </Typography>
            ) : (
              <Typography level="body-sm" className="create-team-price-value">
                Total Price: ${teamSize * pricePerSeat}/month
              </Typography>
            )}
          </Box>
        </FormControl>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }} className="create-team-actions">
          <Button variant="outlined" color="neutral" onClick={handleClose} className="create-team-cancel-button">
            Cancel
          </Button>
          <Button
            disabled={!teamName.trim() || teamSize < ORGANIZATION_SUBSCRIPTION_MIN_SEATS || isLoading || hasError}
            onClick={handleSubmit}
            loading={isSubmitting}
            className="create-team-submit-button"
          >
            {isDevelopment ? 'Create Team (Skip Stripe)' : 'Create Team'}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default CreateTeamModal;

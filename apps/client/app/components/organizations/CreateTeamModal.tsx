import { useSubscribeTeamPlan, useCreateTeamDev } from '@client/app/hooks/data/subscriptions';
import { useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
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
  const { minSeats, maxSeats } = useTeamSeatLimits();
  // Mounted app-wide before settings load, so the initial pick can fall outside a range that arrives
  // later; clamp on read so the stepper, the total and the checkout quantity match what the API accepts.
  const [requestedTeamSize, setTeamSize] = useState(minSeats);
  const teamSize = Math.min(Math.max(Math.round(requestedTeamSize), minSeats), maxSeats);
  // Raw text while the seat field is focused, so it can be empty or out of range mid-edit; null shows teamSize.
  const [teamSizeDraft, setTeamSizeDraft] = useState<string | null>(null);
  const isTeamSizeInvalid = teamSizeDraft !== null && !Number.isFinite(Number.parseFloat(teamSizeDraft));
  const subscribeTeamPlan = useSubscribeTeamPlan();
  const createTeamDev = useCreateTeamDev();
  const plans = useGetSubscriptionPlans();
  // mutation.isPending can't stop a second click fired before React re-renders; this ref
  // is checked synchronously so a rapid double-click can't slip both calls through.
  const submittingRef = useRef(false);

  // null when the team price is unset for this stage or missing from Stripe's active prices. The
  // checkout would then fail server-side or bill an amount the modal never showed, so block it.
  const pricePerSeat = useMemo(() => {
    if (!ORGANIZATION_SUBSCRIPTION_PRICE_ID || !plans.data) return null;
    const plan = plans.data.find(p => p.id === ORGANIZATION_SUBSCRIPTION_PRICE_ID);
    return plan?.unit_amount ? plan.unit_amount / 100 : null;
  }, [plans.data]);

  const handleClose = () => {
    setTeamName('');
    setTeamSize(minSeats);
    setTeamSizeDraft(null);
    close();
  };

  const handleIncreaseTeamSize = () => {
    setTeamSizeDraft(null);
    setTeamSize(Math.min(teamSize + 1, maxSeats));
  };

  const handleDecreaseTeamSize = () => {
    setTeamSizeDraft(null);
    setTeamSize(Math.max(teamSize - 1, minSeats));
  };

  const handleTeamSizeChange = (value: string) => {
    setTeamSizeDraft(value);
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) setTeamSize(parsed);
  };

  // An empty or unparseable field falls back to the last valid size.
  const handleTeamSizeBlur = () => setTeamSizeDraft(null);

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
    } catch {
      // The mutation's onError already toasts; swallow so the click handler leaves no unhandled rejection.
    } finally {
      submittingRef.current = false;
    }
  };

  // isLoading, not "no data yet": the plans query is disabled while credits are not enforced, and
  // a disabled query never gets data, which used to leave this modal on a skeleton for good.
  const isLoading = !isDevelopment && plans.isLoading;
  const hasError = !isDevelopment && !isLoading && (plans.isError || pricePerSeat === null);
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
              disabled={teamSize <= minSeats || isLoading || hasError}
              onClick={handleDecreaseTeamSize}
              className="create-team-size-decrease"
            >
              <RemoveIcon />
            </IconButton>
            <Input
              type="number"
              value={teamSizeDraft ?? String(teamSize)}
              onChange={e => handleTeamSizeChange(e.target.value)}
              onBlur={handleTeamSizeBlur}
              disabled={isLoading || hasError}
              error={isTeamSizeInvalid}
              slotProps={{
                input: {
                  min: minSeats,
                  max: maxSeats,
                  step: 1,
                  'aria-label': 'Team size',
                  'data-testid': 'create-team-size-value',
                },
              }}
              sx={{ width: '88px', '& input': { textAlign: 'center' } }}
              className="create-team-size-value"
            />
            <IconButton
              variant="outlined"
              color="neutral"
              onClick={handleIncreaseTeamSize}
              disabled={isLoading || hasError || teamSize >= maxSeats}
              className="create-team-size-increase"
            >
              <AddIcon />
            </IconButton>
          </Box>
          <Typography level="body-xs" sx={{ mt: 0.5 }} className="create-team-size-note">
            Team size must be between {minSeats} and {maxSeats} members
          </Typography>
          <Box sx={{ mt: 1 }} className="create-team-price-container">
            {isLoading ? (
              <Skeleton variant="text" width={140} level="body-sm" className="create-team-price-loading">
                Total Price: $XXX/month
              </Skeleton>
            ) : hasError ? (
              <Typography
                level="body-sm"
                color="danger"
                className="create-team-price-error"
                data-testid="create-team-price-error"
              >
                Team pricing is unavailable right now. Please try again later.
              </Typography>
            ) : (
              <Typography level="body-sm" className="create-team-price-value" data-testid="create-team-price-value">
                Total Price: ${teamSize * (pricePerSeat ?? 0)}/month
              </Typography>
            )}
          </Box>
        </FormControl>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }} className="create-team-actions">
          <Button variant="outlined" color="neutral" onClick={handleClose} className="create-team-cancel-button">
            Cancel
          </Button>
          <Button
            disabled={!teamName.trim() || isTeamSizeInvalid || teamSize < minSeats || isLoading || hasError}
            onClick={handleSubmit}
            loading={isSubmitting}
            className="create-team-submit-button"
            data-testid="create-team-submit-btn"
          >
            {isDevelopment ? 'Create Team (Skip Stripe)' : 'Create Team'}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default CreateTeamModal;

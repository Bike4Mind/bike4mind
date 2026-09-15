import { useUpdateSubscriptionCredits } from '@client/app/hooks/data/subscriptions';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Stack,
  FormControl,
  FormLabel,
  Input,
  Button,
  Divider,
  Box,
} from '@mui/joy';
import React, { useState, useEffect } from 'react';

interface EditCreditsModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  subscriptionId: string;
  subscriptionName: string;
  subscriptionType: 'individual' | 'team';
  currentCreditsPerCycle: number;
}

const EditCreditsModal: React.FC<EditCreditsModalProps> = ({
  open,
  onClose,
  userId,
  subscriptionId,
  subscriptionName,
  subscriptionType,
  currentCreditsPerCycle,
}) => {
  const [creditsPerCycle, setCreditsPerCycle] = useState<number>(currentCreditsPerCycle);
  const updateCredits = useUpdateSubscriptionCredits();

  useEffect(() => {
    setCreditsPerCycle(currentCreditsPerCycle);
  }, [currentCreditsPerCycle, open]);

  const handleSubmit = async () => {
    if (creditsPerCycle <= 0) return;

    await updateCredits.mutateAsync({
      userId,
      subscriptionId,
      creditsPerCycle,
    });

    handleClose();
  };

  const handleClose = () => {
    setCreditsPerCycle(currentCreditsPerCycle);
    onClose();
  };

  const isFormValid = creditsPerCycle > 0;

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog sx={{ width: '100%', maxWidth: '500px', maxHeight: '90vh', overflowY: 'auto' }}>
        <ModalClose />

        <Typography level="h3" sx={{ mb: 2 }}>
          Edit Subscription Credits
        </Typography>

        <Stack spacing={3}>
          <Box sx={{ p: 2, backgroundColor: 'background.level1', borderRadius: 'md' }}>
            <Typography level="body-sm" sx={{ fontWeight: 'bold' }}>
              {subscriptionType === 'individual' ? 'Individual Plan' : 'Team Plan'}
            </Typography>
            <Typography level="body-sm" color="neutral">
              {subscriptionName}
            </Typography>
          </Box>

          <FormControl>
            <FormLabel>Credits Per Billing Cycle</FormLabel>
            <Input
              type="number"
              placeholder="Enter credits per billing cycle"
              value={creditsPerCycle || ''}
              onChange={e => setCreditsPerCycle(Math.max(0, parseInt(e.target.value) || 0))}
              slotProps={{
                input: {
                  min: 0,
                  step: 1000,
                },
              }}
              data-testid="credits-input"
            />
            <Typography level="body-sm" color="neutral" sx={{ mt: 0.5 }}>
              Set the number of credits this subscription will grant per billing cycle
            </Typography>
          </FormControl>

          {isFormValid && creditsPerCycle !== currentCreditsPerCycle && (
            <Box sx={{ p: 2, backgroundColor: 'background.level1', borderRadius: 'md' }}>
              <Typography level="body-sm" color="primary" sx={{ fontWeight: 'bold' }}>
                {currentCreditsPerCycle.toLocaleString()} → {creditsPerCycle.toLocaleString()} credits per cycle
              </Typography>
              <Typography level="body-xs" color="neutral">
                This will change how many credits the subscription grants each billing period
              </Typography>
            </Box>
          )}

          <Divider />

          <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end' }}>
            <Button variant="outlined" color="neutral" onClick={handleClose} data-testid="cancel-btn">
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleSubmit}
              loading={updateCredits.isPending}
              disabled={!isFormValid || updateCredits.isPending || creditsPerCycle === currentCreditsPerCycle}
              data-testid="submit-btn"
            >
              Update Credits
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default EditCreditsModal;

import React, { useState } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Button,
  ButtonGroup,
  Textarea,
  Divider,
  Stack,
  Box,
  Chip,
  CircularProgress,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { useQueryClient } from '@tanstack/react-query';
import { useUserCreditAdjustments, userCreditAdjustmentsKey } from '../hooks/useUserCreditAdjustments';

interface CreditAdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  selectedUser: any;
  onCreditAdjustment: (userId: string, currentCredits: number, adjustment: number, note?: string) => Promise<void>;
}

export const CreditAdjustmentModal: React.FC<CreditAdjustmentModalProps> = ({
  open,
  onClose,
  selectedUser,
  onCreditAdjustment,
}) => {
  const [creditAmount, setCreditAmount] = useState(100);
  const [creditNote, setCreditNote] = useState('');
  const queryClient = useQueryClient();

  const { data: adjustments, isLoading: adjustmentsLoading } = useUserCreditAdjustments(selectedUser?.id, open);

  const handleClose = () => {
    setCreditAmount(100);
    setCreditNote('');
    onClose();
  };

  const handleCreditAdjustment = async (isAdd: boolean) => {
    if (selectedUser && creditAmount > 0) {
      const adjustment = isAdd ? creditAmount : -creditAmount;
      await onCreditAdjustment(
        selectedUser.id,
        selectedUser.currentCredits || 0,
        adjustment,
        creditNote.trim() || undefined
      );
      queryClient.invalidateQueries({ queryKey: userCreditAdjustmentsKey(selectedUser.id) });
      handleClose();
    }
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog aria-labelledby="credit-adjustment-modal" size="md">
        <ModalClose />
        <Typography id="credit-adjustment-modal" level="h4" mb={1}>
          Adjust Credits
        </Typography>

        {selectedUser && (
          <>
            <Typography level="body-md">
              User: <strong>{selectedUser.fullName || selectedUser.email}</strong>
            </Typography>

            <Typography level="body-md" mb={1}>
              Current Balance: <strong>{selectedUser.currentCredits?.toLocaleString() || 0} credits</strong>
            </Typography>

            <FormControl sx={{ mb: 1 }}>
              <FormLabel>Amount</FormLabel>
              <Input
                type="number"
                value={creditAmount}
                onChange={e => {
                  const value = parseInt(e.target.value);
                  if (!isNaN(value) && value >= 10) {
                    setCreditAmount(value);
                  }
                }}
                endDecorator="credits"
                slotProps={{ input: { min: 10, step: 10 } }}
              />
            </FormControl>

            <FormControl sx={{ mb: 3 }}>
              <FormLabel>Note (optional)</FormLabel>
              <Textarea
                minRows={2}
                maxRows={4}
                placeholder="Reason for adjustment (e.g., 'Promotional bonus', 'Compensation for issue')"
                value={creditNote}
                onChange={e => setCreditNote(e.target.value)}
              />
            </FormControl>

            <ButtonGroup sx={{ justifyContent: 'flex-end', gap: '10px' }}>
              <Button
                variant="soft"
                color="success"
                startDecorator={<AddIcon />}
                onClick={() => handleCreditAdjustment(true)}
                disabled={creditAmount < 10}
              >
                Add Credits
              </Button>
              <Button
                variant="soft"
                color="danger"
                startDecorator={<RemoveIcon />}
                onClick={() => handleCreditAdjustment(false)}
                disabled={creditAmount < 10}
              >
                Remove Credits
              </Button>
            </ButtonGroup>

            <Divider sx={{ my: 2 }} />

            <Typography level="title-sm" mb={1}>
              Recent adjustments
            </Typography>
            {adjustmentsLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size="sm" />
              </Box>
            ) : !adjustments || adjustments.length === 0 ? (
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                No manual adjustments recorded for this user.
              </Typography>
            ) : (
              <Stack
                spacing={1}
                data-testid="credit-adjustment-history"
                sx={{ maxHeight: 220, overflowY: 'auto', pr: 0.5 }}
              >
                {adjustments.map(adj => (
                  <Box
                    key={adj.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 1,
                      p: 1,
                      borderRadius: 'sm',
                      bgcolor: 'background.level1',
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
                        {adj.description || 'Admin credit adjustment'}
                      </Typography>
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {new Date(adj.createdAt).toLocaleString()}
                        {adj.actorName ? ` • by ${adj.actorName}` : ''}
                        {typeof adj.resultingBalance === 'number'
                          ? ` • balance ${adj.resultingBalance.toLocaleString()}`
                          : ''}
                      </Typography>
                    </Box>
                    <Chip size="sm" variant="soft" color={adj.credits >= 0 ? 'success' : 'danger'}>
                      {adj.credits >= 0 ? '+' : ''}
                      {adj.credits.toLocaleString()}
                    </Chip>
                  </Box>
                ))}
              </Stack>
            )}
          </>
        )}
      </ModalDialog>
    </Modal>
  );
};

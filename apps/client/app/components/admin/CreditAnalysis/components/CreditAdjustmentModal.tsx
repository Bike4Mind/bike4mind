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
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';

interface CreditAdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  selectedUser: any;
  onCreditAdjustment: (userId: string, currentCredits: number, adjustment: number) => Promise<void>;
}

export const CreditAdjustmentModal: React.FC<CreditAdjustmentModalProps> = ({
  open,
  onClose,
  selectedUser,
  onCreditAdjustment,
}) => {
  const [creditAmount, setCreditAmount] = useState(100);
  const [creditNote, setCreditNote] = useState('');

  const handleClose = () => {
    setCreditAmount(100);
    setCreditNote('');
    onClose();
  };

  const handleCreditAdjustment = async (isAdd: boolean) => {
    if (selectedUser && creditAmount > 0) {
      const adjustment = isAdd ? creditAmount : -creditAmount;
      await onCreditAdjustment(selectedUser.id, selectedUser.currentCredits || 0, adjustment);
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
              User: <strong>{selectedUser.name || selectedUser.email}</strong>
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
          </>
        )}
      </ModalDialog>
    </Modal>
  );
};

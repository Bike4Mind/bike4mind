import { FC, useState } from 'react';
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Typography,
} from '@mui/joy';

export type TransferCandidate = { id: string; name: string; email?: string | null };

type TransferOwnershipModalProps = {
  open: boolean;
  organizationName: string;
  /** The org's current managers; ownership can only go to one of them (transferOwnership.ts). */
  candidates: TransferCandidate[];
  transferring: boolean;
  onClose: () => void;
  onTransfer: (newOwnerId: string) => Promise<unknown>;
};

const TransferOwnershipModal: FC<TransferOwnershipModalProps> = ({
  open,
  organizationName,
  candidates,
  transferring,
  onClose,
  onTransfer,
}) => {
  const [newOwnerId, setNewOwnerId] = useState<string | null>(null);
  const newOwner = candidates.find(candidate => candidate.id === newOwnerId);

  const close = () => {
    setNewOwnerId(null);
    onClose();
  };

  const submit = async () => {
    if (!newOwnerId) return;
    try {
      await onTransfer(newOwnerId);
      close();
    } catch {
      // The mutation already toasted the server's reason; stay open so the owner can retry or cancel.
    }
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalDialog role="alertdialog" sx={{ maxWidth: 520 }} data-testid="transfer-ownership-modal">
        <DialogTitle>Transfer ownership of {organizationName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <FormControl>
              <FormLabel>New owner</FormLabel>
              <Select
                placeholder="Choose a manager"
                value={newOwnerId}
                onChange={(_event, value) => setNewOwnerId(value)}
                slotProps={{ button: { 'data-testid': 'transfer-ownership-select' } }}
              >
                {candidates.map(candidate => (
                  <Option key={candidate.id} value={candidate.id} data-testid="transfer-ownership-option">
                    {candidate.name}
                    {candidate.email ? ` (${candidate.email})` : ''}
                  </Option>
                ))}
              </Select>
              <FormHelperText>Only a manager can become the owner.</FormHelperText>
            </FormControl>
            <Alert color="warning" variant="soft" data-testid="transfer-ownership-billing-note">
              <Typography level="body-sm">
                {newOwner?.name ?? 'The new owner'} becomes the team&apos;s billing owner. The subscription and payment
                method stay with the team, but only the owner can manage them, so billing, invoices and deleting the
                team move to them. If the billing contact is your email, it changes to theirs. You become a regular
                member and can then leave the team.
              </Typography>
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="danger"
            onClick={submit}
            disabled={!newOwnerId}
            loading={transferring}
            data-testid="transfer-ownership-confirm-btn"
          >
            Transfer ownership
          </Button>
          <Button variant="plain" color="neutral" onClick={close} disabled={transferring}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default TransferOwnershipModal;

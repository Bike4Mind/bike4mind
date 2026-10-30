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
  RadioGroup,
  Radio,
  FormHelperText,
  Divider,
  Stack,
  Box,
  Chip,
  CircularProgress,
} from '@mui/joy';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { useQueryClient } from '@tanstack/react-query';
import { useUserCreditAdjustments, userCreditAdjustmentsKey } from '../hooks/useUserCreditAdjustments';
import { ReasonPicker } from '@client/app/components/admin/shared/ReasonPicker';
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from '@client/app/components/admin/shared/adminReason';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type { CreditChange } from '../types';

interface CreditAdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  selectedUser: AdminUserListItem | null;
  /** Resolves false when the change was rejected; the modal then stays open. */
  onCreditAdjustment: (userId: string, change: CreditChange, note: string) => Promise<boolean>;
}

type Mode = 'adjust' | 'set';
const MAX_BALANCE = 1_000_000_000;

export const CreditAdjustmentModal: React.FC<CreditAdjustmentModalProps> = ({
  open,
  onClose,
  selectedUser,
  onCreditAdjustment,
}) => {
  const [mode, setMode] = useState<Mode>('adjust');
  const [creditAmount, setCreditAmount] = useState(100);
  // undefined until edited, so the field follows the selected user's balance instead of defaulting to a wipe.
  const [targetOverride, setTargetOverride] = useState<number | null | undefined>(undefined);
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const { data: adjustments, isLoading: adjustmentsLoading } = useUserCreditAdjustments(selectedUser?.id, open);

  const isReasonValid = isAdminReasonComplete(reason);
  const currentBalance = selectedUser?.currentCredits ?? 0;
  const targetBalance = targetOverride === undefined ? currentBalance : targetOverride;
  const setDelta = targetBalance === null ? 0 : targetBalance - currentBalance;
  // The server sets against the live balance, so an edited target equal to the list-load snapshot is still
  // submittable: it restores that value if the balance has moved since.
  const canSet =
    isReasonValid &&
    targetOverride !== undefined &&
    targetBalance !== null &&
    Number.isInteger(targetBalance) &&
    targetBalance >= 0;

  const handleClose = () => {
    setMode('adjust');
    setCreditAmount(100);
    setTargetOverride(undefined);
    setReason(EMPTY_ADMIN_REASON);
    onClose();
  };

  // A second click while the first request is in flight would apply a delta twice.
  const submit = async (change: CreditChange) => {
    if (!selectedUser || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (await onCreditAdjustment(selectedUser.id, change, composeAdminReason(reason))) {
        queryClient.invalidateQueries({ queryKey: userCreditAdjustmentsKey(selectedUser.id) });
        handleClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreditAdjustment = async (isAdd: boolean) => {
    if (creditAmount > 0 && isReasonValid) {
      await submit({ kind: 'delta', delta: isAdd ? creditAmount : -creditAmount });
    }
  };

  const handleSetBalance = async () => {
    if (canSet && targetBalance !== null) await submit({ kind: 'set', balance: targetBalance });
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog
        aria-labelledby="credit-adjustment-modal"
        size="md"
        sx={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <ModalClose />
        <Typography id="credit-adjustment-modal" level="h4" mb={1}>
          Adjust Credits
        </Typography>

        {selectedUser && (
          <>
            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
              <Typography level="body-md">
                User: <strong>{selectedUser.name || selectedUser.email}</strong>
              </Typography>

              <Typography level="body-md" mb={1}>
                Current Balance: <strong>{selectedUser.currentCredits?.toLocaleString() || 0} credits</strong>
                <Typography component="span" level="body-sm" sx={{ color: 'text.tertiary', ml: 1 }}>
                  (as of list load)
                </Typography>
              </Typography>

              <RadioGroup
                orientation="horizontal"
                value={mode}
                onChange={e => setMode(e.target.value as Mode)}
                sx={{ gap: 2, mb: 1 }}
              >
                <Radio value="adjust" label="Adjust" data-testid="credit-adjust-mode-adjust" />
                <Radio value="set" label="Set balance" data-testid="credit-adjust-mode-set" />
              </RadioGroup>

              {mode === 'adjust' ? (
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
              ) : (
                <FormControl sx={{ mb: 1 }}>
                  <FormLabel>New balance</FormLabel>
                  <Input
                    type="number"
                    value={targetBalance ?? ''}
                    onChange={e => {
                      const value = parseInt(e.target.value);
                      setTargetOverride(isNaN(value) ? null : Math.min(Math.max(value, 0), MAX_BALANCE));
                    }}
                    endDecorator="credits"
                    slotProps={{ input: { min: 0, step: 1, 'data-testid': 'credit-adjust-set-input' } }}
                  />
                  <FormHelperText data-testid="credit-adjust-set-preview">
                    {targetBalance === null
                      ? 'Enter a balance.'
                      : setDelta === 0
                        ? 'Same as the balance at list load; no change unless it has moved since.'
                        : `Change from list load: ${setDelta > 0 ? '+' : ''}${setDelta.toLocaleString()} credits`}
                  </FormHelperText>
                </FormControl>
              )}

              <Box sx={{ mb: 2 }}>
                <ReasonPicker
                  presets={ADMIN_REASON_PRESETS.creditAdjustment}
                  value={reason}
                  onChange={setReason}
                  data-testid="credit-adjust-reason-input"
                />
              </Box>

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
                          {adj.actorName ? ` \u2022 by ${adj.actorName}` : ''}
                          {typeof adj.resultingBalance === 'number'
                            ? ` \u2022 balance ${adj.resultingBalance.toLocaleString()}`
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
            </Box>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, pt: 2, flexShrink: 0 }}>
              <Button variant="plain" color="neutral" onClick={handleClose} data-testid="credit-adjust-cancel-btn">
                Cancel
              </Button>
              {mode === 'adjust' ? (
                <>
                  <Button
                    variant="soft"
                    color="success"
                    startDecorator={<AddIcon />}
                    onClick={() => handleCreditAdjustment(true)}
                    data-testid="credit-adjust-add-btn"
                    disabled={creditAmount < 10 || !isReasonValid || isSubmitting}
                  >
                    Add Credits
                  </Button>
                  <Button
                    variant="soft"
                    color="danger"
                    startDecorator={<RemoveIcon />}
                    onClick={() => handleCreditAdjustment(false)}
                    data-testid="credit-adjust-remove-btn"
                    disabled={creditAmount < 10 || !isReasonValid || isSubmitting}
                  >
                    Remove Credits
                  </Button>
                </>
              ) : (
                <Button
                  variant="solid"
                  color="primary"
                  startDecorator={<SaveIcon />}
                  onClick={handleSetBalance}
                  data-testid="credit-adjust-set-btn"
                  disabled={!canSet || isSubmitting}
                >
                  Set Balance
                </Button>
              )}
            </Box>
          </>
        )}
      </ModalDialog>
    </Modal>
  );
};

import {
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import { FC, FormEvent, useEffect, useState } from 'react';

interface CreditLimitModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  /** The value currently in force for this target; null when none is set. */
  currentValue: number | null;
  /** 0 is a meaningful per-member limit (blocks their spend) but not a sane org default. */
  allowZero: boolean;
  /** Label for saving null - "Remove limit" for the default, "Use organization default" for a member. */
  clearLabel: string;
  saving: boolean;
  onSave: (value: number | null) => Promise<unknown>;
}

/** Edits one monthly credit limit: the org default or a single member's override. */
const CreditLimitModal: FC<CreditLimitModalProps> = ({
  open,
  onClose,
  title,
  description,
  currentValue,
  allowZero,
  clearLabel,
  saving,
  onSave,
}) => {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (open) setDraft(currentValue == null ? '' : String(Math.round(currentValue)));
  }, [open, currentValue]);

  const parsed = draft.trim() === '' ? null : Number(draft);
  // Whole credits only, matching the API schemas (`.int()`) and the input's step.
  const isValid = parsed != null && Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0);

  const save = async (value: number | null) => {
    try {
      await onSave(value);
      onClose();
    } catch {
      // Kept open so the value can be corrected; the mutation's onError already toasted why.
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (isValid) void save(parsed);
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 460, width: '100%' }} data-testid="credit-limit-modal">
        <ModalClose />
        <Typography level="title-md">{title}</Typography>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          {description}
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack spacing={2} mt={1}>
            <FormControl error={draft.trim() !== '' && !isValid}>
              <FormLabel>Credits per month</FormLabel>
              <Input
                type="number"
                autoFocus
                value={draft}
                onChange={event => setDraft(event.target.value)}
                slotProps={{ input: { min: allowZero ? 0 : 1, step: 1, 'data-testid': 'credit-limit-input' } }}
              />
              <FormHelperText>
                {allowZero ? 'Enter 0 to block spending from the organization pool.' : 'Must be greater than 0.'}
              </FormHelperText>
            </FormControl>
            <Box display="flex" gap={1} justifyContent="space-between" flexWrap="wrap">
              <Button
                variant="plain"
                color="neutral"
                disabled={saving || currentValue == null}
                onClick={() => void save(null)}
                data-testid="credit-limit-clear-btn"
              >
                {clearLabel}
              </Button>
              <Box display="flex" gap={1}>
                <Button variant="outlined" color="neutral" onClick={onClose} data-testid="credit-limit-cancel-btn">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={saving}
                  disabled={!isValid || parsed === currentValue}
                  data-testid="credit-limit-save-btn"
                >
                  Save
                </Button>
              </Box>
            </Box>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
  );
};

export default CreditLimitModal;

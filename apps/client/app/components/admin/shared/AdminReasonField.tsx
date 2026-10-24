import React from 'react';
import { FormControl, FormHelperText, FormLabel, Textarea } from '@mui/joy';
import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  ADMIN_ACTION_REASON_MIN_LENGTH,
  isValidAdminActionReason,
} from '@bike4mind/common';

type AdminReasonFieldProps = {
  value: string;
  onChange: (value: string) => void;
  'data-testid': string;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
};

/**
 * Required "why" input for admin actions the server audits. Pair the confirm button
 * with `isValidAdminActionReason(value)` so both sides enforce the same bounds.
 */
export const AdminReasonField: React.FC<AdminReasonFieldProps> = ({
  value,
  onChange,
  'data-testid': testId,
  label = 'Reason',
  placeholder = 'Why are you doing this? Recorded in the audit log.',
  autoFocus,
}) => {
  const showInvalid = value.length > 0 && !isValidAdminActionReason(value);
  return (
    <FormControl required error={showInvalid}>
      <FormLabel>{label}</FormLabel>
      <Textarea
        minRows={2}
        maxRows={4}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
        slotProps={{ textarea: { maxLength: ADMIN_ACTION_REASON_MAX_LENGTH, 'data-testid': testId } }}
      />
      <FormHelperText>At least {ADMIN_ACTION_REASON_MIN_LENGTH} characters. Recorded in the audit log.</FormHelperText>
    </FormControl>
  );
};

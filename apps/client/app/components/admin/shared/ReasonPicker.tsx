import React, { useId } from 'react';
import { Chip, FormControl, FormHelperText, FormLabel, Stack, Textarea } from '@mui/joy';
import { adminFocusScope } from './adminStyles';
import {
  ADMIN_REASON_HINT,
  type AdminReasonDraft,
  composeAdminReason,
  isAdminReasonComplete,
  maxAdminReasonNoteLength,
} from './adminReason';

type ReasonPickerProps = {
  presets: readonly string[];
  value: AdminReasonDraft;
  onChange: (value: AdminReasonDraft) => void;
  /** Lands on the note textarea; preset chips get `<id>-preset-<index>`. */
  'data-testid': string;
  label?: string;
  autoFocus?: boolean;
  /**
   * False while the endpoint behind this action has no reason field: the helper then says the
   * reason is not stored instead of promising an audit entry.
   */
  audited?: boolean;
};

export const UNSTORED_REASON_NOTE = 'Not stored yet: the audit entry for this action has no reason field.';

/**
 * Required audit reason: preset chips plus a free-text note. Submit `composeAdminReason(value)` and
 * gate the commit on `isAdminReasonComplete(value)` so the UI enforces the server's rule.
 */
export const ReasonPicker: React.FC<ReasonPickerProps> = ({
  presets,
  value,
  onChange,
  'data-testid': testId,
  label = 'Reason',
  autoFocus,
  audited = true,
}) => {
  const labelId = useId();
  const composed = composeAdminReason(value);
  const showInvalid = value.note.length > 0 && !isAdminReasonComplete(value);

  const togglePreset = (preset: string) => onChange({ ...value, preset: value.preset === preset ? null : preset });

  return (
    <FormControl required error={showInvalid} sx={adminFocusScope}>
      <FormLabel id={labelId}>{label}</FormLabel>
      {presets.length > 0 && (
        <Stack role="group" aria-labelledby={labelId} direction="row" flexWrap="wrap" gap={0.75} sx={{ mb: 1 }}>
          {presets.map((preset, index) => {
            const selected = value.preset === preset;
            return (
              <Chip
                key={preset}
                size="sm"
                variant={selected ? 'solid' : 'outlined'}
                color={selected ? 'primary' : 'neutral'}
                onClick={() => togglePreset(preset)}
                slotProps={{ action: { 'aria-pressed': selected, 'data-testid': `${testId}-preset-${index}` } }}
              >
                {preset}
              </Chip>
            );
          })}
        </Stack>
      )}
      <Textarea
        minRows={2}
        maxRows={4}
        autoFocus={autoFocus}
        placeholder={value.preset ? 'Add a note (optional)' : 'Why are you doing this? Recorded in the audit log.'}
        value={value.note}
        onChange={event => onChange({ ...value, note: event.target.value })}
        slotProps={{
          textarea: {
            maxLength: maxAdminReasonNoteLength(value.preset),
            'aria-label': value.preset ? `${label} note` : label,
            'data-testid': testId,
          },
        }}
      />
      <FormHelperText data-testid={`${testId}-helper`}>
        {!audited
          ? isAdminReasonComplete(value)
            ? UNSTORED_REASON_NOTE
            : `${ADMIN_REASON_HINT} ${UNSTORED_REASON_NOTE}`
          : isAdminReasonComplete(value)
            ? `Recorded in the audit log as "${composed}".`
            : `${ADMIN_REASON_HINT} Recorded in the audit log.`}
      </FormHelperText>
    </FormControl>
  );
};

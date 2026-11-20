import React from 'react';
import { FormControl, FormHelperText, FormLabel, Option, Select } from '@mui/joy';
import {
  SUSPENSION_REASON_CATEGORIES,
  SUSPENSION_REASONS,
  buildSuspensionNotice,
  type SuspensionReasonCategory,
} from '@bike4mind/common';
import { usePublicConfig } from '@client/app/hooks/data/settings';

export const SUSPENSION_CATEGORY_REQUIRED = 'Choose the reason the user is told.';

/**
 * The required "Reason shown to the user" select, with a preview of the notice the user sees. Shared by
 * the single-account and bulk suspend dialogs so both send the same `suspensionReasonCategory`.
 */
export const SuspensionCategoryField: React.FC<{
  value: SuspensionReasonCategory | null;
  onChange: (value: SuspensionReasonCategory | null) => void;
  testIdPrefix: string;
}> = ({ value, onChange, testIdPrefix }) => {
  const { data: publicConfig } = usePublicConfig();
  return (
    <FormControl required>
      <FormLabel>Reason shown to the user</FormLabel>
      <Select
        placeholder="Choose a Terms of Service reason"
        value={value}
        onChange={(_event, next) => onChange(next)}
        slotProps={{ button: { 'data-testid': `${testIdPrefix}-category-select` } }}
      >
        {SUSPENSION_REASON_CATEGORIES.map(option => (
          <Option key={option} value={option} data-testid={`${testIdPrefix}-category-option-${option}`}>
            {SUSPENSION_REASONS[option].adminLabel}
          </Option>
        ))}
      </Select>
      <FormHelperText data-testid={`${testIdPrefix}-category-preview`}>
        {value
          ? `They will see: "${buildSuspensionNotice(value, { email: publicConfig?.supportEmail }).message}"`
          : 'They see this category and how to appeal. Never which signals flagged them.'}
      </FormHelperText>
    </FormControl>
  );
};

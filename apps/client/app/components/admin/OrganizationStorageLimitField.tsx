import { FC } from 'react';
import { FormControl, FormHelperText, FormLabel, Input, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB } from '@bike4mind/common';
import { useOrgStorageUsage } from '@client/app/hooks/data/useOrgStorageUsage';

export type ParsedStorageLimit = { valid: true; storageLimit: number | null } | { valid: false };

/** Empty clears the override (null, so the default applies); otherwise a non-negative decimal MB. */
export const parseStorageLimitInput = (input: string): ParsedStorageLimit => {
  const trimmed = input.trim();
  if (trimmed === '') return { valid: true, storageLimit: null };
  // Number, not parseInt: parseInt truncates, so a fractional MB like 0.5 could not be entered.
  const storageLimit = Number(trimmed);
  if (!Number.isFinite(storageLimit) || storageLimit < 0) return { valid: false };
  return { valid: true, storageLimit };
};

type OrganizationStorageLimitFieldProps = {
  orgId: string;
  value: string;
  onChange: (value: string) => void;
};

/** Platform-admin control for Organization.storageLimit, with the org's current usage against its effective limit. */
const OrganizationStorageLimitField: FC<OrganizationStorageLimitFieldProps> = ({ orgId, value, onChange }) => {
  const { data: usage, isError } = useOrgStorageUsage(orgId);
  const isInvalid = !parseStorageLimitInput(value).valid;

  const renderUsage = () => {
    if (isError) return 'Usage unavailable';
    if (!usage) return 'Loading usage...';
    return `${prettyBytes(usage.usedBytes)} / ${prettyBytes(usage.limitBytes)} used`;
  };

  return (
    <FormControl error={isInvalid}>
      <FormLabel>Storage Limit</FormLabel>
      <Input
        type="number"
        value={value}
        placeholder={String(DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB)}
        onChange={e => onChange(e.target.value)}
        slotProps={{ input: { min: 0, step: 'any', 'data-testid': 'admin-org-storage-limit-input' } }}
        endDecorator={
          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            MB limit
          </Typography>
        }
      />
      <FormHelperText data-testid="admin-org-storage-usage">
        {isInvalid
          ? 'Enter a number of MB, 0 or more'
          : `${renderUsage()}. Leave empty for the default (${DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB.toLocaleString()} MB).`}
      </FormHelperText>
    </FormControl>
  );
};

export default OrganizationStorageLimitField;

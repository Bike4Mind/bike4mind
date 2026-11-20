import { Stack, type StackProps } from '@mui/joy';
import { forwardRef } from 'react';

export const settingFieldRowStyles = {
  width: '100%',
  minWidth: 0,
  py: 2,
  gap: 2,
  color: 'admin.ink',
  overflowWrap: 'anywhere',
  '&:not(:last-child)': { borderBottom: '1px solid', borderColor: 'admin.border' },
} as const;

export const SettingFieldRow = forwardRef<HTMLDivElement, StackProps>(function SettingFieldRow({ sx, ...props }, ref) {
  return (
    <Stack
      ref={ref}
      data-admin-setting-row
      {...props}
      sx={[settingFieldRowStyles, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    />
  );
});

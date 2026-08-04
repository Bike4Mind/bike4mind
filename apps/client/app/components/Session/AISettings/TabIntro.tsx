import React from 'react';
import { Stack, Typography } from '@mui/joy';

/**
 * The title + description block heading each tab of the AI Settings modal. Shared so the
 * three tabs cannot drift apart on size, colour or spacing.
 */
export const TabIntro: React.FC<{
  title: string;
  description: React.ReactNode;
  /** Sits inline after the title, e.g. a ContextHelpButton. */
  titleAdornment?: React.ReactNode;
  /** Clears the tab bar. Override with 0 where an ancestor already supplies the offset. */
  mt?: string | number;
}> = ({ title, description, titleAdornment, mt = '20px' }) => (
  <Stack direction="column" alignItems="flex-start" gap="4px" sx={{ width: 'auto', mt }}>
    <Stack direction="row" alignItems="center" gap="4px">
      <Typography sx={{ color: 'text.primary', fontSize: '16px', fontWeight: '500' }}>{title}</Typography>
      {titleAdornment}
    </Stack>
    <Typography sx={{ color: 'text.primary50', fontSize: '14px', pr: { sm: 4 }, lineHeight: '1.4' }}>
      {description}
    </Typography>
  </Stack>
);

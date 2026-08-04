import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/joy';
import { brandAlpha } from '@client/app/utils/themes/colors';

interface DataLakeEmptyStateProps {
  /** Sized by the caller; 18px reads correctly inside the 40px badge. */
  icon: ReactNode;
  title: string;
  /** Body copy. Accepts nodes so callers can break a line where it reads best. */
  children: ReactNode;
  /** Merged last, e.g. `py` when the state is a block rather than a pane that fills its parent. */
  sx?: Record<string, unknown>;
  'data-testid'?: string;
}

/**
 * Centred empty state shared by the Data Lake surfaces (the manager's right pane, the Discover
 * catalog) so they cannot drift apart. The tinted icon badge is the same one the advanced-search
 * drawer uses.
 */
export default function DataLakeEmptyState({
  icon,
  title,
  children,
  sx,
  'data-testid': testId,
}: DataLakeEmptyStateProps) {
  return (
    <Box
      data-testid={testId}
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 4,
        color: 'text.tertiary',
        textAlign: 'center',
        ...sx,
      }}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: '10px',
          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </Box>
      <Typography level="title-lg" sx={{ color: 'text.primary', fontSize: '16px', mt: '16px', mb: '12px' }}>
        {title}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', fontSize: '13px', maxWidth: 380 }}>
        {children}
      </Typography>
    </Box>
  );
}

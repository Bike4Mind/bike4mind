import type { ReactNode } from 'react';
import { Box, IconButton, useTheme } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';

interface ComposerNoteProps {
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
  'data-testid'?: string;
  dismissTestId?: string;
  sx?: SxProps;
}

/**
 * The frame every account note in the stack above the composer's status line shares (SessionBottom):
 * amber wash, 8px padding, content on the left and a quiet close button on the right - grey, full
 * colour on hover, no background. The content brings its own 13px text.
 */
export function ComposerNote({ children, onDismiss, dismissLabel, dismissTestId, sx, ...rest }: ComposerNoteProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const border = isDarkMode ? 'rgba(234, 179, 8, 0.4)' : 'rgba(202, 138, 4, 0.35)';
  const bg = isDarkMode ? 'rgba(120, 80, 20, 0.35)' : 'rgba(254, 249, 195, 0.8)';

  return (
    <Box
      data-testid={rest['data-testid']}
      sx={[
        {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 1,
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: '8px',
          p: '8px',
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {/* Centred on the 28px close button's first-line height, so one-line notes sit level with it. */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: '28px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        {children}
      </Box>
      <IconButton
        data-testid={dismissTestId}
        size="sm"
        variant="plain"
        onClick={onDismiss}
        aria-label={dismissLabel}
        sx={{ ...HEADER_ICON_BUTTON_SX, flexShrink: 0 }}
      >
        <CloseRoundedIcon sx={{ fontSize: '16px' }} />
      </IconButton>
    </Box>
  );
}

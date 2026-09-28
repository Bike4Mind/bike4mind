import { Box, Sheet } from '@mui/joy';
import type { ReactNode } from 'react';

/**
 * The bordered card a full-page surface sits in (the Gears page), kept apart
 * from it so the next such surface starts from the same frame.
 *
 * Owns the scrolling too. The app layout is a fixed-height shell, so a page
 * taller than the viewport must scroll itself or the overflow is simply clipped.
 */
const PageFrame = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <Box
    sx={{
      height: '100%',
      // The page is the only scroller: the frame grows to its content and this
      // container scrolls it. Padding (not centring) sets the gap above the
      // frame, so the same gap is there when scrolled back to the top - a
      // centred frame would collapse that space as soon as content overflowed.
      overflowY: 'auto',
      overflowX: 'hidden',
      // One tight gap on every side: the frame is itself a bordered card, so it
      // only needs to clear the shell, not float in it.
      p: '8px',
    }}
  >
    <Sheet
      variant="outlined"
      data-testid={testId}
      sx={theme => ({
        width: '100%',
        maxWidth: '1400px',
        mx: 'auto',
        // Fills the container when the content is short, grows past it when long.
        // Measured against the container rather than the viewport: the app shell
        // insets the page area, so a `100vh` frame always overflowed by that inset.
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        borderColor: theme.palette.divider,
        // The sidebar surface in dark mode, the Joy Sheet default in light.
        backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.surface2 : undefined,
        p: { xs: '20px', md: '32px' },
      })}
    >
      {children}
    </Sheet>
  </Box>
);

export default PageFrame;

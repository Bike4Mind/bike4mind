import { Box, Sheet } from '@mui/joy';
import type { ReactNode } from 'react';

/**
 * The bordered card a full-page surface sits in, shared by Tutorials and Gears
 * so the two read as one family. Extracted rather than copied: they are the same
 * surface at different stages of the same feature, and a divergence between them
 * is a bug rather than a choice.
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
      // Side gutters keep the frame off the viewport edges once it is narrower
      // than its cap; the vertical padding stays tighter so the frame is not
      // squeezed on short screens.
      px: { xs: '16px', sm: '24px', md: '40px' },
      py: { xs: '16px', md: '24px' },
    }}
  >
    <Sheet
      variant="outlined"
      data-testid={testId}
      sx={theme => ({
        width: '100%',
        maxWidth: '1400px',
        mx: 'auto',
        // Fills the viewport when the content is short, grows past it when long.
        // Subtracts the container's own vertical padding so the frame ends
        // exactly where the bottom gap begins.
        minHeight: { xs: 'calc(100vh - 32px)', md: 'calc(100vh - 48px)' },
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

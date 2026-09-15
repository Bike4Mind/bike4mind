import { useTheme } from '@mui/joy';
import { useMediaQuery } from '@mui/system';

export function useIsMobile() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  return isMobile;
}

// True below the `md` breakpoint (<900px), i.e. mobile AND tablet.
// Use for layout that should adapt across the whole sub-desktop range
// (e.g. sidebar overlay, composer icon-only labels). Keep `useIsMobile`
// (<600px) for behavior that must stay phone-only (e.g. modal-vs-dropdown).
export function useIsTablet() {
  const theme = useTheme();
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));
  return isTablet;
}

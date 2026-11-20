import { Box, Divider, type BoxProps } from '@mui/joy';
import { forwardRef } from 'react';
import { SIDENAV } from './metrics';
import { navStackSx, pinnedSx, searchBarSx, sectionSx } from './styles';

const merge = (base: BoxProps['sx'], sx: BoxProps['sx']): BoxProps['sx'] => [
  ...(Array.isArray(base) ? base : [base]),
  ...(Array.isArray(sx) ? sx : [sx]),
];

const withClass = (own: string, className?: string) => [own, className].filter(Boolean).join(' ');

export const SidenavPinned = forwardRef<HTMLDivElement, BoxProps>(function SidenavPinned(
  { sx, className, ...rest },
  ref
) {
  return (
    <Box
      ref={ref}
      className={withClass('notebook-sidenav-pinned', className)}
      {...rest}
      sx={merge(theme => pinnedSx(theme), sx)}
    />
  );
});

export const SidenavSection = ({ sx, className, ...rest }: BoxProps) => (
  <Box className={withClass('notebook-sidenav-container', className)} {...rest} sx={merge(sectionSx, sx)} />
);

export const SidenavNavStack = ({ sx, className, ...rest }: BoxProps) => (
  <Box className={withClass('notebook-sidenav-nav', className)} {...rest} sx={merge(navStackSx, sx)} />
);

export const SidenavSearchBar = ({ top, sx, className, children, ...rest }: BoxProps & { top: number }) => (
  <Box
    className={withClass('notebook-sidenav-search-container', className)}
    {...rest}
    sx={merge(theme => searchBarSx(theme, top), sx)}
  >
    <Divider sx={{ mb: SIDENAV.searchDividerGap }} />
    {children}
  </Box>
);

import type { Theme } from '@mui/joy/styles';
import { SIDENAV } from './metrics';

type SidenavTokens = { navItemText?: string; navItemIcon?: string; pinnedBackdrop?: string; filterActiveBg?: string };
type NotebookListTokens = { focusedBackground?: string; hoverBg?: string };

// Overlays typecheck without the host's palette augmentation, so read the keys through a narrow cast.
export const sidenavTokens = (theme: Theme): SidenavTokens =>
  (theme.palette as unknown as { sidenav?: SidenavTokens }).sidenav ?? {};

export const notebookListTokens = (theme: Theme): NotebookListTokens =>
  (theme.palette as unknown as { notebooklist?: NotebookListTokens }).notebooklist ?? {};

export const navRowSx = (theme: Theme, active: boolean) => {
  const list = notebookListTokens(theme);
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    px: `${SIDENAV.rowPadX}px`,
    height: `${SIDENAV.rowHeight}px`,
    minHeight: `${SIDENAV.rowHeight}px`,
    borderRadius: SIDENAV.rowRadius,
    cursor: 'pointer',
    color: sidenavTokens(theme).navItemText ?? theme.palette.text.primary,
    backgroundColor: active ? list.focusedBackground : 'transparent',
    transition: 'background 0.15s',
    '&:hover': { backgroundColor: active ? list.focusedBackground : list.hoverBg },
    '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
  };
};

export const iconSlotSx = (theme: Theme) => {
  const icon = sidenavTokens(theme).navItemIcon;
  return {
    width: 20,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    // Joy SvgIcons resolve their color from --Icon-color, which wins over plain `color`.
    '--Icon-color': icon,
    color: icon,
    opacity: theme.palette.mode === 'dark' ? 0.75 : 0.5,
  };
};

export const newActionTileSx = {
  width: 20,
  height: 20,
  borderRadius: '6px',
  backgroundColor: 'primary.500',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
} as const;

export const navLabelSx = { fontSize: '14px', fontWeight: 400, color: 'inherit' } as const;

export const conversationRowSx = (theme: Theme, selected: boolean) => {
  const list = notebookListTokens(theme);
  return {
    position: 'relative',
    borderRadius: SIDENAV.rowRadius,
    cursor: 'pointer',
    backgroundColor: selected ? list.focusedBackground : 'transparent',
    '&::before': selected
      ? {
          content: '""',
          position: 'absolute',
          left: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          width: '2px',
          height: '80%',
          backgroundColor: theme.palette.primary[500],
          borderRadius: '1px',
        }
      : {},
    '&:hover': { backgroundColor: selected ? list.focusedBackground : list.hoverBg },
  } as const;
};

export const groupHeaderSx = { color: 'text.tertiary', marginBottom: '0.1em' } as const;

export const listRowsSx = { display: 'flex', flexDirection: 'column', gap: SIDENAV.listRowGap } as const;

export const pinnedSx = (theme: Theme) =>
  ({
    position: 'sticky',
    top: 0,
    zIndex: 3,
    backgroundColor: sidenavTokens(theme).pinnedBackdrop,
    pt: SIDENAV.pinnedTop,
  }) as const;

export const sectionSx = { display: 'flex', flexDirection: 'column' } as const;

export const navStackSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: SIDENAV.rowGap,
  mt: SIDENAV.navTop,
} as const;

export const searchBarSx = (theme: Theme, top: number) =>
  ({
    position: 'sticky',
    top: `${top}px`,
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: sidenavTokens(theme).pinnedBackdrop,
    pt: SIDENAV.searchTop,
    pb: SIDENAV.searchBottom,
  }) as const;

import { Box, Dropdown, IconButton, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  MENU_ROW_ICON_SX,
  menuRowSx,
  menuSurfaceSx,
} from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';

/**
 * The three-dots trigger for a row's actions: compact for a narrow rail, and frameless like the
 * tree header's own icon buttons - only the icon brightens, no ground appears under it. The
 * variant vars are zeroed because Joy paints hover/active fills from them, and a filled square
 * inside an already-highlighted row reads as a second, competing surface.
 */
const TRIGGER_SX = {
  '--IconButton-size': '20px',
  '--Icon-color': 'currentColor',
  '--variant-plainHoverBg': 'transparent',
  '--variant-plainActiveBg': 'transparent',
  // Joy sizes an IconButton with min-width/min-height plus its own paddingInline, so the box
  // grows past those minimums to fit the glyph. Pin the dimensions and drop the padding to get
  // an exactly 20px square.
  width: '20px',
  height: '20px',
  minWidth: '20px',
  minHeight: '20px',
  paddingInline: 0,
  color: 'text.tertiary',
  transition: 'color 0.3s',
  '&:hover': { backgroundColor: 'transparent', color: 'text.primary' },
} as const;

/** Icon frame for this menu's rows - tighter than the profile menu's 22px to suit 32px rows. */
const MENU_ICON_FRAME_SX = { ...MENU_ROW_ICON_SX, width: 20, height: 20 } as const;

/**
 * One item in a row's action menu, styled like the profile menu's rows. Joy MenuItem needs
 * --variant-plainHoverBg pointed at the hover colour too, or its own variant rule wins over the
 * shared recipe's `&:hover`.
 */
export function RowMenuItem({
  testId,
  icon,
  label,
  onClick,
  danger,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <MenuItem
      // Joy's own danger palette, so the destructive row picks up its text, icon and hover tint
      // rather than only the shared recipe's colour.
      color={danger ? 'danger' : 'neutral'}
      data-testid={testId}
      onClick={onClick}
      sx={itemTheme => ({
        ...menuRowSx(itemTheme, danger),
        // Take the destructive colour from Joy's danger plain variant, exactly as the sidebar's
        // session Delete item does - the shared recipe's hardcoded danger[500] is a different red.
        ...(danger && { color: itemTheme.palette.danger.plainColor, '--Icon-color': 'currentColor' }),
        '--variant-plainHoverBg': danger
          ? itemTheme.palette.danger.plainHoverBg
          : itemTheme.palette.notebooklist.hoverBg,
        // Tighter than the profile menu's 40px/10px: this menu hangs off a row in a narrow rail.
        // Both of these override a direct declaration in the shared recipe, so they must be set
        // here as declarations too - the Joy vars below alone would lose to it.
        height: '32px',
        px: '4px',
        gap: '8px',
        // Joy drives row geometry from these vars, so pin them to the values above rather than
        // relying on sx winning the cascade against Joy's own rule.
        '--ListItem-paddingLeft': '4px',
        '--ListItem-paddingRight': '4px',
        '--ListItem-paddingY': '0px',
        '--ListItem-minHeight': '32px',
        '--ListItem-radius': '8px',
        '--ListItem-gap': '8px',
      })}
    >
      <Box sx={MENU_ICON_FRAME_SX}>{icon}</Box>
      <Typography level="body-sm" noWrap sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }}>
        {label}
      </Typography>
    </MenuItem>
  );
}

/**
 * A row's actions folded behind one three-dots trigger, sharing the profile menu's floating
 * surface. Used by the Data Lake tree's file rows and the manager's lifecycle rows, so the two
 * cannot drift apart.
 *
 * The caller owns revealing it on hover (see the `.dl-row-actions` rules on those rows) and, where
 * the row itself is clickable, stopping the click from reaching the row.
 */
export function RowActionsMenu({
  testId,
  ariaLabel,
  children,
}: {
  testId: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Dropdown>
      {/* variant/color go on the MenuButton itself, not only on the IconButton slot: MenuButton
          emits its OWN variant class, and its 'outlined' default would paint a border and a hover
          fill over the plain slot underneath. */}
      <MenuButton
        variant="plain"
        color="neutral"
        size="sm"
        slots={{ root: IconButton }}
        slotProps={{ root: { 'aria-label': ariaLabel, 'data-testid': testId, sx: TRIGGER_SX } }}
      >
        <MoreVertIcon sx={{ fontSize: 16 }} />
      </MenuButton>
      <Menu
        size="sm"
        placement="bottom-end"
        sx={menuTheme => ({
          ...menuSurfaceSx(menuTheme),
          borderRadius: '8px',
          minWidth: 180,
          // Joy's List vars, pinned for the same reason as the row's: p:1 from the shared recipe
          // would otherwise fight --List-padding.
          '--List-padding': '8px',
          '--List-radius': '8px',
          '--List-gap': '2px',
        })}
      >
        {children}
      </Menu>
    </Dropdown>
  );
}

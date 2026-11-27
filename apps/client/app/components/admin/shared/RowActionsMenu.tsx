import type { ReactNode } from 'react';
import { Dropdown, IconButton, Menu, MenuButton } from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { adminFocus } from './adminStyles';

type RowActionsMenuProps = {
  testId: string;
  /** Names the row, e.g. `Actions for ${user.email}`. */
  ariaLabel: string;
  disabled?: boolean;
  loading?: boolean;
  /** For a row that opens on click: keeps the trigger and the menu from reaching the row's handler. */
  stopRowClick?: boolean;
  /** `MenuItem`s, optionally split by a `ListDivider`. */
  children: ReactNode;
};

const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * The one "..." menu a table row uses for its actions (DESIGN_GUIDE "Tables"): a ghost icon button that
 * fits the default `DataTable` action column and opens a menu aligned to its right edge.
 */
export function RowActionsMenu({ testId, ariaLabel, disabled, loading, stopRowClick, children }: RowActionsMenuProps) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            loading,
            'aria-label': ariaLabel,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        disabled={disabled}
        data-testid={testId}
        {...(stopRowClick && { onClick: stopPropagation, onKeyDown: stopPropagation })}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      {/* Above admin dialogs and drawers, which a menu opened from inside one would otherwise sit behind. */}
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }} {...(stopRowClick && { onClick: stopPropagation })}>
        {children}
      </Menu>
    </Dropdown>
  );
}

import { Box, Typography, type BoxProps } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import type { ElementType, HTMLAttributes, KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import { SIDENAV } from './metrics';
import { iconSlotSx, navLabelSx, navRowSx, newActionTileSx } from './styles';

export const NavIcon = ({ children }: { children: ReactNode }) => <Box sx={iconSlotSx}>{children}</Box>;

export const NewActionIcon = () => (
  <Box sx={newActionTileSx}>
    <AddIcon sx={{ fontSize: '16px', color: '#fff' }} />
  </Box>
);

const trailingSlotSx = {
  ml: 'auto',
  mr: `${(SIDENAV.rowHeight - SIDENAV.tagHeight) / 2 - SIDENAV.rowPadX}px`,
  display: 'flex',
  flexShrink: 0,
  '&:empty': { display: 'none' },
} as const;

export type SidenavNavRowProps = {
  icon: ReactNode;
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onClick?: (e: SyntheticEvent<HTMLElement>) => void;
  component?: ElementType;
  to?: string;
  href?: string;
  type?: 'button';
  sx?: BoxProps['sx'];
} & Omit<HTMLAttributes<HTMLElement>, 'onClick' | 'children'> & {
    [dataAttr: `data-${string}`]: string | undefined;
  };

export const SidenavNavRow = ({
  icon,
  label,
  active = false,
  disabled = false,
  trailing,
  onClick,
  component,
  sx,
  ...rest
}: SidenavNavRowProps) => {
  const activate = (e: SyntheticEvent<HTMLElement>) => {
    // A disabled link row must not follow its href, which Enter still clicks through pointer-events: none.
    if (disabled) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  // A caller-chosen element (a router Link, a <button>) brings its own semantics and keyboard.
  const asButton = component === undefined;
  return (
    <Box
      component={component}
      {...rest}
      {...(asButton && {
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate(e);
          }
        },
      })}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      onClick={activate}
      sx={[
        theme => ({
          ...navRowSx(theme, active),
          ...(disabled && { opacity: 0.5, pointerEvents: 'none' }),
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {icon}
      <Typography level="body-sm" sx={navLabelSx} noWrap>
        {label}
      </Typography>
      {/* Pulled into the row's padding so the tag sits evenly inset on three sides, and dropped
          when empty so a tag that renders nothing leaves the row as if it had none. */}
      {trailing && <Box sx={trailingSlotSx}>{trailing}</Box>}
    </Box>
  );
};

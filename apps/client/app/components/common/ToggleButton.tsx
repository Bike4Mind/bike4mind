import { Button, ButtonProps } from '@mui/joy';
import { PropsWithChildren, forwardRef } from 'react';

interface IProps {
  toggle: boolean;
  onClick: () => void;
}

const ToggleButton = forwardRef<HTMLButtonElement, PropsWithChildren<IProps & ButtonProps>>(
  ({ toggle, onClick, children, ...rest }, ref) => {
    return (
      <Button
        className="toggle-button"
        sx={theme => ({
          borderRadius: '6px',
          display: 'flex',
          gap: '10px',
          fontWeight: 400,
          paddingX: '10px',
          border: '1px solid transparent',
          '&:hover': {
            background: theme.palette.common.toggleButton.activeHoverBackground,
          },
          ...(toggle
            ? {
                background: theme.palette.common.toggleButton.activeHoverBackground,
              }
            : {
                border: `1px solid ${theme.palette.common.toggleButton.inactiveBorder}`,
                background: theme.palette.common.toggleButton.inactiveBackground,
              }),
        })}
        color={'neutral'}
        variant={'solid'}
        size="sm"
        {...rest}
        ref={ref}
        onClick={onClick}
      >
        {children}
      </Button>
    );
  }
);

ToggleButton.displayName = 'ToggleButton';

export default ToggleButton;

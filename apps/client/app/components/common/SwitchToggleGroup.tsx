import React, { ReactNode } from 'react';
import { Grid, Tooltip, Theme, Button } from '@mui/joy';
import type { SxProps } from '@mui/system';
import { brand } from '../../utils/themes/colors';

export interface ToggleOption {
  value: string;
  label?: string;
  icon?: ReactNode;
  text?: string;
}

interface SwitchToggleGroupProps {
  options: ToggleOption[];
  value: string;
  onChange: (value: string) => void;
  containerSx?: SxProps<Theme>;
  buttonSx?: SxProps<Theme>;
  activeColor?: string;
  activeDisplayColor?: string;
}

/**
 * A customizable toggle button group component that allows switching between options
 * Each option displays an icon and can show a tooltip on hover
 */
const SwitchToggleGroup = React.forwardRef<HTMLDivElement, SwitchToggleGroupProps>(
  (
    {
      options,
      value,
      onChange,
      containerSx = {},
      buttonSx = {},
      activeColor = brand[800],
      activeDisplayColor = 'white',
    },
    ref
  ) => {
    return (
      <Grid
        ref={ref}
        container
        columns={options.length}
        gap={0.5}
        className="toggle-group-container"
        sx={{
          ...containerSx,
          alignSelf: 'stretch',
        }}
      >
        {options.map(option => {
          const isActive = value === option.value;
          return (
            <Tooltip key={option.value} title={option.label} className="toggle-group-tooltip">
              <Button
                onClick={() => onChange(option.value)}
                size="sm"
                className={`toggle-group-button ${isActive ? 'toggle-group-button-active' : ''}`}
                sx={{
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: isActive ? activeColor : 'transparent',
                  color: isActive ? activeDisplayColor : 'text.primary',
                  '&:hover': {
                    backgroundColor: isActive ? undefined : theme => theme.palette.primary.softHoverBg,
                    color: isActive ? undefined : theme => theme.palette.common.switchToggleGroup.hoverColor,
                  },
                  fontWeight: '500',
                  ...buttonSx,
                }}
              >
                {option.icon}
                {option.text}
              </Button>
            </Tooltip>
          );
        })}
      </Grid>
    );
  }
);

SwitchToggleGroup.displayName = 'SwitchToggleGroup';

export default SwitchToggleGroup;

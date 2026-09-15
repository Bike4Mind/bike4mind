import React from 'react';
import { commonTheme } from '@client/app/utils/themes/components/common';
import { useTheme } from '@mui/joy/styles';

interface SquareSlideToggleProps {
  checked: boolean;
  onChange: (event: { target: { checked: boolean } }) => void;
  disabled?: boolean;
  width?: number;
  height?: number;
  'data-testid'?: string;
}

const SquareSlideToggle: React.FC<SquareSlideToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  width = 50,
  height = 30,
  'data-testid': dataTestId,
}) => {
  const muiTheme = useTheme();
  const theme = commonTheme[muiTheme.palette.mode === 'dark' ? 'dark' : 'light'];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={dataTestId}
      onClick={disabled ? undefined : () => onChange({ target: { checked: !checked } })}
      style={{
        backgroundColor: checked ? theme.slideToggle.backgroundOn : theme.slideToggle.backgroundOff,
        width: `${width}px`,
        height: `${height}px`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        padding: '2px',
        borderRadius: '4px',
      }}
      disabled={disabled}
    >
      <div
        style={{
          backgroundColor: checked ? theme.slideToggle.thumbOn : theme.slideToggle.thumbOff,
          width: '45%',
          height: '80%',
          top: '10%',
          borderRadius: '1px',
          transform: checked ? 'translateX(110%)' : 'translateX(10%)',
        }}
      ></div>
    </button>
  );
};

export default SquareSlideToggle;

import React from 'react';
import { Slider, styled } from '@mui/joy';
import { gray, grayAlpha } from '@client/app/utils/themes/colors';

const StyledSlider = styled(Slider)({
  color: gray[670],
  height: 3,
  padding: '13px 0',
  '& .MuiSlider-thumb': {
    height: 16,
    width: 16,
    backgroundColor: 'white',
    border: `2px solid ${gray[670]}`,
    '&:hover, &.Mui-focusVisible': {
      boxShadow: `0 0 0 8px ${grayAlpha[668][16]}`,
    },
  },
  '& .MuiSlider-track': {
    height: 3,
    backgroundColor: gray[670],
  },
  '& .MuiSlider-rail': {
    height: 3,
    backgroundColor: gray[730],
    opacity: 1,
  },
  '& .MuiSlider-mark': {
    backgroundColor: gray[670],
    height: 8,
    width: 1,
    '&.MuiSlider-markActive': {
      opacity: 1,
      backgroundColor: gray[670],
    },
  },
  '& .MuiSlider-valueLabel': {
    display: 'none',
  },
});

export const INFINITE_VALUE = 14;

interface FibonacciSliderProps {
  onChange: (newValue: number | number[]) => void;
  value: number;
  defaultValue?: number;
}

const FibonacciSlider: React.FC<FibonacciSliderProps> = ({ onChange, value, defaultValue = 0 }) => {
  const marks = [
    { value: 0, label: '0' },
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 6, label: '6' },
    { value: 8, label: '8' },
    { value: 12, label: '12' },
    { value: INFINITE_VALUE, label: '∞' },
  ];

  return (
    <StyledSlider
      defaultValue={defaultValue}
      aria-label="Fibonacci Slider"
      size="sm"
      min={0}
      max={INFINITE_VALUE}
      track="normal"
      step={1}
      marks={marks}
      value={isFinite(value) ? value : INFINITE_VALUE}
      onChange={(_, newValue) => onChange(Number(newValue))}
    />
  );
};

export default FibonacciSlider;

import { Select as JuiSelect, Option } from '@mui/joy';
import { SxProps } from '@mui/joy/styles/types';
import { FC } from 'react';

interface IProps {
  options: readonly string[];
  value: string | null;
  onSelect:
    | React.Dispatch<React.SetStateAction<string>>
    | React.Dispatch<React.SetStateAction<string | null>>
    | ((value: string | null) => void);
  size?: 'lg' | 'md' | 'sm';
  disabled?: boolean;
  hasNone?: boolean;
  noneTitle?: string;
  sx?: SxProps;
  multiple?: boolean;
  noneValue?: string;
  'data-testid'?: string;
}

const Select: FC<IProps> = ({
  value,
  options,
  onSelect,
  size = 'md',
  disabled = false,
  hasNone = true,
  noneTitle = 'None',
  sx = null,
  multiple = false,
  noneValue = '',
  'data-testid': dataTestId,
}) => {
  return (
    <JuiSelect
      sx={sx}
      multiple={multiple}
      size={size}
      value={value}
      variant="outlined"
      // @ts-ignore
      onChange={(_, value) => onSelect(value)}
      disabled={disabled}
      placeholder={noneTitle}
      slotProps={{
        button: {
          'data-testid': dataTestId,
        },
      }}
    >
      {hasNone && <Option value={noneValue}>{noneTitle}</Option>}
      {options.map(option => (
        <Option key={option} value={option}>
          {option}
        </Option>
      ))}
    </JuiSelect>
  );
};

export default Select;

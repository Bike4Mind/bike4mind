import React, { ChangeEvent, Dispatch, FC, useCallback, useRef, useState, SetStateAction } from 'react';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import { Input, IconButton } from '@mui/joy';
import { InputProps } from '@mui/joy';

interface IProps extends InputProps {
  handleChange: ((value: string) => void) | Dispatch<SetStateAction<string>>;
  placeHolder?: string;
  height?: string | number;
  width?: string | number;
  debounceTimeout?: number;
  showSearchBar?: boolean;
  onClose?: () => void;
}

const SearchBar: FC<IProps> = ({
  handleChange,
  width,
  placeHolder = 'Search by name or tags',
  height = '1em',
  debounceTimeout = 1000,
  showSearchBar,
  onClose,
  ...rest
}) => {
  const [inputValue, setInputValue] = useState('');
  const timerRef = useRef<number | null>(null);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInputValue(value);

      if (debounceTimeout) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          handleChange(value);
          timerRef.current = 0;
        }, debounceTimeout);
      } else {
        handleChange(value);
      }
    },
    [debounceTimeout, handleChange]
  );

  const handleClear = () => {
    setInputValue('');
    handleChange('');
  };

  const handleClose = () => {
    handleClear();
    if (onClose) {
      onClose();
    }
  };

  return (
    <Input
      {...rest}
      value={inputValue}
      placeholder={placeHolder}
      onChange={onChange}
      fullWidth={!width}
      startDecorator={
        <SearchIcon
          sx={theme => ({
            width: '20px',
            height: '20px',
            color: theme.palette.text.primary,
            opacity: 0.5,
          })}
        />
      }
      endDecorator={
        <IconButton
          variant="plain"
          color="neutral"
          size="sm"
          onClick={handleClose}
          sx={{
            visibility: inputValue || (showSearchBar && onClose) ? 'visible' : 'hidden',
            width: '16px',
            height: '16px',
            minWidth: '16px',
            minHeight: '16px',
          }}
        >
          <CloseIcon
            sx={{
              width: '14px',
              height: '14px',
              color: 'text.primary',
            }}
          />
        </IconButton>
      }
      sx={theme => ({
        ['--Input-placeholderColor' as any]: theme.palette.text.primary,
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '100%',
        fontStyle: 'normal',
        borderRadius: 'var(--Input-radius)',
        boxShadow: 'none',
        border: `1px solid ${theme.palette.border.input}`,
        background: theme.palette.searchbar.background,
        color: theme.palette.searchbar.color,
        opacity: 1,
        minHeight: 'auto',
        maxHeight: '36px',
        height: '36px',
        pr: 2,
        '& input': {
          color: 'text.primary',
        },
        '& input::placeholder': {
          opacity: 0.5,
          color: 'var(--Input-placeholderColor)',
        },
        '& input::-webkit-input-placeholder': {
          color: 'var(--Input-placeholderColor)',
          opacity: 0.5,
        },
        '& input::-moz-placeholder': {
          color: 'var(--Input-placeholderColor)',
          opacity: 0.5,
        },
        '&:focus-within .MuiSvgIcon-root': {},
        ...(width ? { width } : {}),
      })}
    />
  );
};

export default SearchBar;

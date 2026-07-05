import { FC, useState, useCallback, useRef, ChangeEvent } from 'react';
import { Box, Input, IconButton } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';

interface SearchBarWithToggleProps {
  handleChange: (value: string) => void;
  placeHolder?: string;
  className?: string;
  debounceTimeout?: number;
}

const SearchBarWithToggle: FC<SearchBarWithToggleProps> = ({
  handleChange,
  placeHolder = 'Search',
  className,
  debounceTimeout = 300,
}) => {
  const [isActive, setIsActive] = useState(false);
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
    setIsActive(false);
  };

  const handleSearchClick = () => {
    setIsActive(!isActive);
    if (isActive) {
      // If closing, clear the search
      setInputValue('');
      handleChange('');
    }
  };

  return (
    <Box
      className={className}
      data-testid="search-bar-with-toggle"
      sx={theme => ({
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid',
        borderColor: 'border.input',
        borderRadius: '6px',
        height: '32px',
        width: isActive ? { xs: '200px', sm: '285px' } : '32px',
        position: 'relative',
        transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        backgroundColor: theme.palette.background.surface2,
        zIndex: 1000,
      })}
    >
      {/* Search Icon */}
      <IconButton
        data-testid="search-toggle-btn"
        onClick={handleSearchClick}
        variant="plain"
        color="neutral"
        size="sm"
        sx={{
          position: 'absolute',
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 2,
          minWidth: '32px',
          minHeight: '32px',
          cursor: 'pointer',
          opacity: isActive ? 0 : 1,
          visibility: isActive ? 'hidden' : 'visible',
          transition: 'opacity 0.25s ease-out',
        }}
      >
        <SearchIcon
          sx={{
            fontSize: '20px',
            color: 'text.primary',
          }}
        />
      </IconButton>

      {/* Search Input */}
      <Input
        value={inputValue}
        onChange={onChange}
        placeholder={placeHolder}
        sx={theme => ({
          position: 'absolute',
          top: '50%',
          transform: 'translateY(-50%)',
          width: isActive ? '100%' : '0',
          border: 'none',
          background: 'transparent',
          fontSize: '13px',
          transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          padding: 0,
          '& input': {
            padding: '0 32px 0 0',
            textIndent: '8px',
            color: 'text.primary',
            fontSize: '16px',
          },
          '& input::placeholder': {
            color: 'text.primary50',
          },
        })}
      />

      {/* Clear Icon */}
      <IconButton
        data-testid="search-clear-btn"
        onClick={handleClear}
        variant="plain"
        color="neutral"
        size="sm"
        sx={{
          position: 'absolute',
          right: '4px',
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: isActive ? 1 : 0,
          transition: 'opacity 0.2s ease-out',
          minWidth: '24px',
          minHeight: '24px',
          cursor: 'pointer',
        }}
      >
        <CloseIcon sx={{ fontSize: '16px', color: 'text.primary50' }} />
      </IconButton>
    </Box>
  );
};

export default SearchBarWithToggle;

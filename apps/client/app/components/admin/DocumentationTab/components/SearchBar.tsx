import React from 'react';
import { Input, Stack } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import { IconButton } from '@mui/joy';

interface SearchBarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  placeholder?: string;
}

export const SearchBar: React.FC<SearchBarProps> = ({ searchTerm, onSearchChange, placeholder = 'Search...' }) => {
  const handleClear = () => {
    onSearchChange('');
  };

  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Input
        startDecorator={<SearchIcon />}
        endDecorator={
          searchTerm && (
            <IconButton variant="plain" size="sm" onClick={handleClear} sx={{ '--IconButton-size': '20px' }}>
              <ClearIcon fontSize="small" />
            </IconButton>
          )
        }
        placeholder={placeholder}
        value={searchTerm}
        onChange={e => onSearchChange(e.target.value)}
        sx={{ flex: 1 }}
      />
    </Stack>
  );
};

import { Input } from '@mui/joy';
import { FC } from 'react';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
}

const SearchInput: FC<SearchInputProps> = ({ value, onChange }) => {
  return (
    <Input
      size="lg"
      placeholder="Search tasks..."
      value={value}
      onChange={e => onChange(e.target.value)}
      startDecorator={<SearchRoundedIcon />}
      sx={{
        '--Input-focusedThickness': '0.1rem',
        flexGrow: 1,
      }}
    />
  );
};

export default SearchInput;

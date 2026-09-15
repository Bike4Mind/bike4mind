import { ISearchFabFilesParams } from '@client/app/hooks/data/fabFiles';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { Search } from '@mui/icons-material';
import { Box, Input, Option, Select } from '@mui/joy';
import { debounce } from 'lodash';
import { FC, useState } from 'react';
import { FILE_TYPE_OPTIONS } from './constants';

interface FileBrowserFilterProps {
  value?: ISearchFabFilesParams;
  onChange?: (params: ISearchFabFilesParams) => void;
}

const debounceFn = debounce((fn: () => void) => fn(), 500);

const FileBrowserFilter: FC<FileBrowserFilterProps> = ({ value, onChange }) => {
  const [search, setSearch] = useState(value?.search || '');

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    debounceFn(() => {
      onChange?.({ ...value, search: e.target.value });
    });
  };

  const handleFileTypeChange = (val: string) => {
    onChange?.({
      ...value,
      filters: {
        ...(value?.filters || {}),
        type: val === 'all' ? undefined : (val as any),
      },
    });
  };

  return (
    <Box className="file-browser-filter-container" sx={{ display: 'flex', gap: 1, flex: '1', alignItems: 'center' }}>
      <Input
        className="file-browser-filter-search-input"
        data-testid="file-browser-search-input"
        startDecorator={
          <Search
            className="file-browser-filter-search-icon"
            sx={theme => ({
              width: '20px',
              height: '20px',
              color: 'grey',
            })}
          />
        }
        placeholder="Search files..."
        value={search}
        onChange={handleSearchChange}
        sx={theme => ({
          flexGrow: 1,
          width: '70%',
          minHeight: '32px',
          boxShadow: 'none',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '100%',
          borderRadius: '6px',
          color: theme => theme.palette.text.primary,
          background: theme => theme.palette.fileBrowser.surface,
          '& .MuiInput-root': {
            minHeight: '32px',
          },
          '& input': {
            minHeight: '28px',
          },
          '& input::placeholder': {
            fontSize: '14px',
            fontWeight: '400',
            lineHeight: '150%',
            color: theme.palette.searchbar.color,
            opacity: 0.7,
          },
          '&:focus-within .MuiSvgIcon-root': {
            color: theme.palette.mode === 'dark' ? 'white' : 'black',
          },
        })}
      />
      <Select
        className="file-browser-filter-type-select"
        placeholder="File Type"
        value={value?.filters?.type || 'all'}
        onChange={(_, value) => handleFileTypeChange(value as string)}
        indicator={<KeyboardArrowDownIcon sx={{ fontSize: 10 }} />}
        sx={{
          width: '150px',
          height: '32px',
          minHeight: '32px',
          paddingTop: 0,
          paddingBottom: 0,
          borderRadius: '6px',
          boxShadow: 'none',
          background: theme => theme.palette.neutral.solidBg,

          // Override MUI defaults
          '& .MuiSelect-root': {
            height: '32px',
            minHeight: '32px',
          },
          // text style
          color: 'text.primary',
          fontSize: '14px',
          fontWeight: '400',
        }}
      >
        {FILE_TYPE_OPTIONS.map(option => (
          <Option key={option.value} className="file-browser-filter-type-option" value={option.value}>
            {option.label}
          </Option>
        ))}
      </Select>
    </Box>
  );
};

export default FileBrowserFilter;

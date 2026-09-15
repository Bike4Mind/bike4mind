import { Stack } from '@mui/joy';
import { Typography, Box, Tooltip, Button } from '@mui/joy';
import { FC } from 'react';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import MenuButton from '@mui/joy/MenuButton';
import Menu from '@mui/joy/Menu';
import MenuItem from '@mui/joy/MenuItem';
import { Add, Close } from '@mui/icons-material';
import { IFileTag } from '@bike4mind/common';

interface FileBrowserTagFiltersProps {
  options: IFileTag[];
  value: string[];
  onChange: (value: string[]) => void;
  onClearAll?: () => void;
}

const FileBrowserTagFilters: FC<FileBrowserTagFiltersProps> = ({ options, value, onChange, onClearAll }) => {
  const availableOptions = options.filter(option => !value.includes(option.name));
  return (
    <Box className="tag-filter-container">
      <Stack className="tag-filter-header" direction="row" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
        <Typography
          className="tag-filter-header-text"
          level="body-sm"
          sx={{ fontWeight: 500, color: 'text.primary', opacity: 0.5 }}
        >
          Active Tags
        </Typography>
        {onClearAll && value.length > 0 && (
          <Button
            className="tag-filter-clear-button"
            variant="plain"
            size="sm"
            onClick={onClearAll}
            sx={{
              fontSize: '12px',
              textDecoration: 'underline',
              p: 0,
              minHeight: 'auto',
              color: 'text.primary',
              opacity: 0.5,
              '&:hover': {
                backgroundColor: 'transparent',
                opacity: 1,
              },
            }}
          >
            (Clear all)
          </Button>
        )}
      </Stack>
      <Stack className="tag-filter-chips-container" direction="row" gap="8px" alignItems="center">
        {value.map(tag => (
          <Chip
            className="tag-filter-chip"
            key={tag}
            size="sm"
            variant="soft"
            onClick={() => onChange(value.filter(t => t !== tag))}
            endDecorator={<Close sx={{ fontSize: 12, opacity: 0.5 }} />}
            sx={theme => ({
              bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
              border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
            })}
          >
            {tag}
          </Chip>
        ))}
        {availableOptions.length > 0 && (
          <Dropdown>
            <Tooltip className="tag-filter-tooltip" title="Add active tag">
              <MenuButton
                className="tag-filter-menu-button"
                component={IconButton}
                variant="solid"
                color="primary"
                size="sm"
                sx={{
                  p: 0,
                  borderRadius: '20px',
                  minWidth: '20px',
                  maxWidth: '20px',
                  minHeight: '20px',
                  width: '20px',
                  height: '20px',
                }}
              >
                <Add sx={{ fontSize: 14 }} />
              </MenuButton>
            </Tooltip>
            <Menu
              className="tag-filter-menu"
              sx={theme => ({
                zIndex: 1400,
                maxHeight: '300px',
                overflowY: 'auto',
                p: '8px 4px',
                '& .MuiMenuItem-root + .MuiMenuItem-root': {
                  mt: 0.5,
                },
                '&::-webkit-scrollbar-thumb': {
                  backgroundColor: theme.palette.background.scrollbar,
                  border: `2px solid ${theme.palette.background.scrollbarTrack}`,
                  borderRadius: '20px',
                },
                '&::-webkit-scrollbar': {
                  width: '8px',
                },
                '&::-webkit-scrollbar-track': {
                  backgroundColor: theme.palette.background.scrollbarTrack,
                },
              })}
            >
              {options.map(tag => (
                <MenuItem
                  className="tag-filter-menu-item"
                  key={tag.id}
                  onClick={() => {
                    onChange([...value, tag.name]);
                  }}
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}
                >
                  <Box
                    className="tag-filter-menu-item-icon"
                    sx={{
                      minWidth: '24px',
                      height: '24px',
                      bgcolor: tag.color,
                      fontSize: '14px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '6px',
                    }}
                  >
                    {tag.icon}
                  </Box>
                  <Box className="tag-filter-menu-item-text">{tag.name}</Box>
                </MenuItem>
              ))}
            </Menu>
          </Dropdown>
        )}
      </Stack>
    </Box>
  );
};

export default FileBrowserTagFilters;

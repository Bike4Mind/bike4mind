import React, { useState } from 'react';
import { Box, Stack, Input, Typography, Select, Option, Radio } from '@mui/joy';
import {
  Search as SearchIcon,
  FilterAlt as FilterAltIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  SwapVert as SwapVertIcon,
} from '@mui/icons-material';
import { FILE_TYPE_OPTIONS } from './constants';
import { UploadActionsSelect } from './UploadActionsSelect';

interface MobileSearchFilterProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  sortField: 'fileName' | 'fileSize' | 'createdAt';
  sortDirection: 'asc' | 'desc';
  onSortChange: (field: 'fileName' | 'fileSize' | 'createdAt', direction: 'asc' | 'desc') => void;
  // File filter props (My Files / Shared / Curated)
  fileFilterType?: 'all' | 'shared' | 'curated';
  onFileFilterChange?: (filterType: 'all' | 'shared' | 'curated') => void;
  // File type filter props
  fileTypeValue?: string;
  onFileTypeChange?: (type: string) => void;
  // Upload props
  onUploadFiles?: (files: File[]) => void;
  onAddFromUrl?: () => void;
  onCreateKnowledge?: () => void;
  onCreateDataLake?: () => void;
  isUploading?: boolean;
}

export const MobileSearchFilter: React.FC<MobileSearchFilterProps> = ({
  searchValue,
  onSearchChange,
  sortField,
  sortDirection,
  onSortChange,
  fileFilterType = 'all',
  onFileFilterChange,
  fileTypeValue = 'all',
  onFileTypeChange,
  onUploadFiles,
  onAddFromUrl,
  onCreateKnowledge,
  onCreateDataLake,
  isUploading = false,
}) => {
  const [sortSelectOpen, setSortSelectOpen] = useState(false);
  const [filterSelectOpen, setFilterSelectOpen] = useState(false);

  const getCurrentSortValue = () => {
    return `${sortField}-${sortDirection}`;
  };

  const handleSortChange = (value: string | null) => {
    if (!value) return;
    const [field, direction] = value.split('-') as ['fileName' | 'fileSize' | 'createdAt', 'asc' | 'desc'];
    onSortChange(field, direction);
  };

  const checkBoxStyle = {
    '--Radio-size': '16px',
    '--Radio-color': 'var(--joy-palette-primary-500)',
    '--Radio-checkedColor': 'var(--joy-palette-primary-500)',
    '--Radio-borderColor': 'var(--joy-palette-neutral-400)',
    '--Radio-checkedBorderColor': 'var(--joy-palette-primary-500)',
  };

  return (
    <Box sx={{ display: { xs: 'block', md: 'none' }, px: 0, mb: 0 }}>
      <Stack direction="row" gap={1} alignItems="center">
        <Input
          placeholder="Search files..."
          value={searchValue}
          onChange={e => onSearchChange(e.target.value)}
          startDecorator={<SearchIcon sx={{ fontSize: '16px' }} />}
          sx={{
            flex: 1,
            minHeight: '32px',
            boxShadow: 'none',
            color: theme => theme.palette.text.primary,
            background: 'transparent',
            '& .MuiInput-input': {
              fontSize: '14px',
            },
          }}
        />
        {onFileFilterChange && (
          <Select
            data-testid="mobile-file-filter-select"
            value={fileFilterType}
            onChange={(_, value) => {
              if (value) onFileFilterChange(value as 'all' | 'shared' | 'curated');
            }}
            indicator={<KeyboardArrowDownIcon sx={{ fontSize: '10px' }} />}
            sx={{
              minWidth: '120px',
              height: '32px !important',
              minHeight: '32px !important',
              maxHeight: '32px !important',
              backgroundColor: 'var(--joy-palette-background-body)',
              border: '1px solid var(--joy-palette-divider)',
              borderRadius: '8px',
              boxShadow: 'none',
              py: 0,
              px: 1,
              color: 'text.primary',
              fontSize: '13px',
              fontWeight: '400',
              '& .MuiSelect-indicator': {
                color: 'text.tertiary',
              },
            }}
            slotProps={{
              listbox: {
                sx: {
                  minWidth: '140px',
                  border: 'none !important',
                  py: '4px !important',
                  backgroundColor: 'var(--joy-palette-background-body)',
                  '& .MuiOption-root': {
                    color: 'text.primary',
                    fontSize: '14px',
                    fontWeight: '400',
                    backgroundColor: 'var(--joy-palette-background-body)',
                  },
                },
                placement: 'bottom-end',
                modifiers: [
                  { name: 'offset', options: { offset: [0, 4] } },
                  { name: 'preventOverflow', options: { padding: 8 } },
                ],
              },
            }}
          >
            <Option value="all">My Files</Option>
            <Option value="shared">Shared Files</Option>
            <Option value="curated">Curated Files</Option>
          </Select>
        )}
        <Select
          value={getCurrentSortValue()}
          onChange={(_, newValue) => handleSortChange(newValue)}
          listboxOpen={sortSelectOpen}
          onListboxOpenChange={isOpen => {
            setSortSelectOpen(isOpen);
            if (isOpen) {
              setFilterSelectOpen(false);
            }
          }}
          startDecorator={
            <SwapVertIcon
              sx={{
                color: 'text.primary',
                width: '16px',
                height: '16px',
                margin: '0',
                flex: 'none',
              }}
            />
          }
          endDecorator={
            <KeyboardArrowDownIcon
              sx={{
                color: 'var(--joy-palette-text-primary)',
                width: '16px',
                height: '16px',
                strokeWidth: '3px',
                display: { xs: 'none', sm: 'block' },
              }}
            />
          }
          sx={{
            minWidth: { xs: '32px', sm: '140px' },
            width: { xs: '32px', sm: 'auto' },
            height: '32px !important',
            minHeight: '32px !important',
            maxHeight: '32px !important',
            backgroundColor: 'var(--joy-palette-background-body)',
            border: '1px solid var(--joy-palette-divider)',
            borderRadius: '8px',
            justifyContent: 'center',
            boxShadow: 'none',
            py: 0,
            px: 1,
            '& .MuiSelect-button': {
              display: { xs: 'flex', sm: 'flex' },
              position: { xs: 'absolute', sm: 'relative' },
              top: { xs: 0, sm: 'auto' },
              left: { xs: 0, sm: 'auto' },
              zIndex: { xs: 100, sm: 'auto' },
              width: '100%',
              height: '100%',
              alignItems: 'center',
              justifyContent: { xs: 'center', sm: 'flex-start' },
              gap: 1,
              textAlign: 'left',
              fontSize: { xs: '0px', sm: '14px' },
              lineHeight: { xs: 0, sm: 'normal' },
              color: { xs: 'transparent', sm: 'text.primary' },
            },
            '& .MuiSelect-startDecorator': {
              mr: { xs: 0, sm: 1 },
              flex: 'none',
            },
            '& .MuiSelect-endDecorator': {
              display: { xs: 'none', sm: 'inline-flex' },
            },
            '& .MuiSelect-indicator': {
              display: 'none',
            },
            '&:focus-within': {
              borderColor: 'var(--joy-palette-primary-500)',
            },
          }}
          slotProps={{
            listbox: {
              sx: {
                minWidth: '200px',
                border: 'none !important',
                py: '4px !important',
                backgroundColor: 'var(--joy-palette-background-body)',
                '& .MuiOption-root': {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  justifyContent: 'flex-start',
                  color: 'text.primary',
                  fontSize: '14px',
                  fontWeight: '400',
                  backgroundColor: 'var(--joy-palette-background-body)',
                },
              },
              placement: 'bottom-end',
              modifiers: [
                { name: 'offset', options: { offset: [-0, 4] } },
                { name: 'preventOverflow', options: { padding: 8 } },
              ],
            },
          }}
        >
          <Option value="fileName-asc">
            <Radio
              checked={getCurrentSortValue() === 'fileName-asc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Name <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(A-Z)</Typography>
              </Typography>
            </Box>
          </Option>
          <Option value="fileName-desc">
            <Radio
              checked={getCurrentSortValue() === 'fileName-desc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Name <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(Z-A)</Typography>
              </Typography>
            </Box>
          </Option>
          <Option value="createdAt-desc">
            <Radio
              checked={getCurrentSortValue() === 'createdAt-desc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Date <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(Newest)</Typography>
              </Typography>
            </Box>
          </Option>
          <Option value="createdAt-asc">
            <Radio
              checked={getCurrentSortValue() === 'createdAt-asc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Date <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(Oldest)</Typography>
              </Typography>
            </Box>
          </Option>
          <Option value="fileSize-asc">
            <Radio
              checked={getCurrentSortValue() === 'fileSize-asc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Size <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(Smallest)</Typography>
              </Typography>
            </Box>
          </Option>
          <Option value="fileSize-desc">
            <Radio
              checked={getCurrentSortValue() === 'fileSize-desc'}
              onChange={() => {}}
              size="sm"
              sx={checkBoxStyle}
            />
            <Box>
              <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>
                Size <Typography sx={{ color: 'text.secondary', fontSize: '14px' }}>(Biggest)</Typography>
              </Typography>
            </Box>
          </Option>
        </Select>
        {onFileTypeChange && (
          <Select
            value={fileTypeValue}
            onChange={(_, newValue) => onFileTypeChange(newValue as string)}
            listboxOpen={filterSelectOpen}
            onListboxOpenChange={isOpen => {
              setFilterSelectOpen(isOpen);
              if (isOpen) {
                setSortSelectOpen(false);
              }
            }}
            startDecorator={
              <FilterAltIcon
                sx={{
                  color: 'text.primary',
                  width: '16px',
                  height: '16px',
                  margin: '0',
                  flex: 'none',
                }}
              />
            }
            endDecorator={
              <KeyboardArrowDownIcon
                sx={{
                  color: 'var(--joy-palette-text-primary)',
                  width: '16px',
                  height: '16px',
                  strokeWidth: '3px',
                  display: { xs: 'none', sm: 'block' },
                }}
              />
            }
            sx={{
              minWidth: { xs: '32px', sm: '120px' },
              width: { xs: '32px', sm: 'auto' },
              height: '32px !important',
              minHeight: '32px !important',
              maxHeight: '32px !important',
              backgroundColor: 'var(--joy-palette-background-body)',
              border: '1px solid var(--joy-palette-divider)',
              borderRadius: '8px',
              justifyContent: 'center',
              boxShadow: 'none',
              py: 0,
              px: 1,
              '& .MuiSelect-button': {
                display: { xs: 'flex', sm: 'flex' },
                position: { xs: 'absolute', sm: 'relative' },
                top: { xs: 0, sm: 'auto' },
                left: { xs: 0, sm: 'auto' },
                zIndex: { xs: 100, sm: 'auto' },
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: { xs: 'center', sm: 'flex-start' },
                gap: 1,
                textAlign: 'left',
                fontSize: { xs: '0px', sm: '14px' },
                lineHeight: { xs: 0, sm: 'normal' },
                color: { xs: 'transparent', sm: 'text.primary' },
              },
              '& .MuiSelect-startDecorator': {
                mr: { xs: 0, sm: 1 },
                flex: 'none',
              },
              '& .MuiSelect-endDecorator': {
                display: { xs: 'none', sm: 'inline-flex' },
              },
              '& .MuiSelect-indicator': {
                display: 'none',
              },
              '&:focus-within': {
                borderColor: 'var(--joy-palette-primary-500)',
              },
            }}
            slotProps={{
              listbox: {
                sx: {
                  minWidth: '160px',
                  border: 'none !important',
                  py: '4px !important',
                  backgroundColor: 'var(--joy-palette-background-body)',
                  '& .MuiOption-root': {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    justifyContent: 'flex-start',
                    color: 'text.primary',
                    fontSize: '14px',
                    fontWeight: '400',
                    backgroundColor: 'var(--joy-palette-background-body)',
                  },
                },
                placement: 'bottom-end',
                modifiers: [
                  { name: 'offset', options: { offset: [-0, 4] } },
                  { name: 'preventOverflow', options: { padding: 8 } },
                ],
              },
            }}
          >
            {FILE_TYPE_OPTIONS.map(option => (
              <Option key={option.value} value={option.value}>
                {option.label}
              </Option>
            ))}
          </Select>
        )}

        {/* Upload Select */}
        {(onUploadFiles || onAddFromUrl || onCreateKnowledge || onCreateDataLake) && (
          <UploadActionsSelect
            onUploadFiles={onUploadFiles}
            onAddFromUrl={onAddFromUrl}
            onCreateKnowledge={onCreateKnowledge}
            onCreateDataLake={onCreateDataLake}
            isUploading={isUploading}
            variant="mobile"
          />
        )}
      </Stack>
    </Box>
  );
};

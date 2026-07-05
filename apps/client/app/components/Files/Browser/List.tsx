import { IFabFileDocument, IFileTag } from '@bike4mind/common';
import { SwapVert } from '@mui/icons-material';
import { Box, Grid, IconButton, LinearProgress, Typography, Select, Option, Button } from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { FC } from 'react';
import { useTranslation } from 'react-i18next';
import FileBrowserItem from './Item';
import { TagType } from '@bike4mind/common';
import FileBrowserTagFilters from './TagFilter';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

export interface FileBrowserListProps {
  files: IFabFileDocument[];
  viewType?: 'list' | 'grid';
  fileTags?: IFileTag[];
  emptyDescription?: string;
  sortField?: 'fileName' | 'fileSize' | 'createdAt';
  sortDirection?: 'asc' | 'desc';
  onSortChange?: (field: 'fileName' | 'fileSize' | 'createdAt', direction: 'asc' | 'desc') => void;
  isLoading?: boolean;
  isFetching?: boolean;
  // Pagination props
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  // New props for the dropdown
  fileFilterType?: 'all' | 'shared' | 'curated';
  onFileFilterChange?: (filterType: 'all' | 'shared' | 'curated') => void;
  onOpenTagManager?: () => void;
  // Tags section props
  availableTagOptions?: IFileTag[];
  selectedTags?: string[];
  onTagsChange?: (tags: string[]) => void;
  onClearAll?: () => void;
}

type SortField = 'fileName' | 'fileSize' | 'createdAt';

const FileBrowserList: FC<FileBrowserListProps> = ({
  files,
  viewType = 'list',
  fileTags,
  emptyDescription = 'You have no files, go out there and create some!',
  sortField = 'fileName',
  sortDirection = 'asc',
  onSortChange,
  isLoading = false,
  isFetching = false,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  fileFilterType = 'all',
  onFileFilterChange,
  onOpenTagManager,
  availableTagOptions,
  selectedTags,
  onTagsChange,
  onClearAll,
}) => {
  const { t } = useTranslation();

  function getTags(file: IFabFileDocument): IFileTag[] | undefined {
    // For shared files, show all tags from the file itself
    if (fileFilterType === 'shared') {
      return (
        file.tags?.map(tag => {
          const existingTag = fileTags?.find(userTag => userTag.name.toLowerCase() === tag.name.toLowerCase());

          if (existingTag) {
            return existingTag;
          }

          const tagColors = [
            '#FF6B6B',
            '#4ECDC4',
            '#45B7D1',
            '#96CEB4',
            '#FECA57',
            '#FF9FF3',
            '#54A0FF',
            '#5F27CD',
            '#00D2D3',
            '#FF9F43',
          ];

          const tagIcons = ['🏷️', '📌', '⭐', '🔖', '💡', '🎯', '📍', '✨', '🎨', '🔗'];

          const hashCode = tag.name.split('').reduce((a, b) => {
            a = (a << 5) - a + b.charCodeAt(0);
            return a & a;
          }, 0);

          const colorIndex = Math.abs(hashCode) % tagColors.length;
          const iconIndex = Math.abs(hashCode) % tagIcons.length;

          return {
            id: tag.name,
            name: tag.name,
            icon: tagIcons[iconIndex],
            color: tagColors[colorIndex],
            description: '',
            fileCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastActivityAt: new Date(),
            userId: file.userId,
            type: TagType.FILE,
          } as IFileTag;
        }) || []
      );
    }

    return fileTags?.filter(tag => file.tags?.some(t => t.name.toLowerCase() === tag.name.toLowerCase()));
  }

  const handleSort = (field: SortField) => {
    if (!onSortChange) return;
    if (sortField === field) {
      onSortChange(field, sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      onSortChange(field, 'asc');
    }
  };

  const handleFileFilterChange = (value: string) => {
    if (onFileFilterChange) {
      onFileFilterChange(value as 'all' | 'shared' | 'curated');
    }
  };

  const renderSortingControls = () => {
    return (
      <>
        {/* Header - Desktop Layout */}
        <Box
          sx={{
            flexShrink: 0,
            display: { xs: 'none', md: 'grid' },
            // title, sort by text, name, date, size
            gridTemplateColumns: '1fr 80px 80px 80px 80px',
            gap: '12px',
            alignItems: 'center',
            mb: 3,
          }}
        >
          {/* All Files Column and Tag Manager */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {onOpenTagManager && (
              <Button
                className="file-browser-tag-manager-button"
                onClick={onOpenTagManager}
                variant="outlined"
                color="neutral"
                startDecorator={<LocalOfferIcon sx={{ fontSize: 16 }} />}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: { xs: '100%', sm: 'auto' },
                  borderRadius: '6px',
                  height: { xs: '40px', sm: '32px' },
                  minHeight: { xs: '40px', sm: '32px' },
                  fontSize: '14px',
                  fontWeight: '400',
                  lineHeight: '150%',
                  color: 'text.primary',
                  backgroundColor: theme => theme.palette.fileBrowser.surface,
                  '&:hover': {
                    backgroundColor: theme => theme.palette.notebooklist.hoverBg,
                  },
                }}
              >
                Tag Manager
              </Button>
            )}

            <Select
              className="file-browser-view-type-select"
              value={fileFilterType}
              onChange={(_, value) => handleFileFilterChange(value as string)}
              indicator={<KeyboardArrowDownIcon sx={{ fontSize: '10px' }} />}
              sx={{
                width: '140px',
                height: '32px',
                minHeight: '32px',
                paddingTop: 0,
                paddingBottom: 0,
                background: theme => theme.palette.fileBrowser.surface,
                boxShadow: 'none',

                // text style
                color: 'text.primary',
                fontSize: '14px',
                fontWeight: '400',
              }}
            >
              <Option value="all">My Files</Option>
              <Option value="shared">Shared Files</Option>
              <Option value="curated">Curated Files</Option>
            </Select>
          </Box>

          {/* Actions column */}
          <Box
            className="file-browser-sort-controls"
            sx={{ display: 'flex', alignItems: 'center', gap: '8px', flexDirection: 'row' }}
          >
            <SwapVert style={{ color: 'fileBrowser.lightTextColor', width: '18px', height: '18px' }} strokeWidth={2} />
            <Typography
              className="file-browser-sort-label"
              level="body-xs"
              sx={{ color: 'fileBrowser.lightTextColor', fontSize: '14px', fontWeight: '400' }}
            >
              Sort by
            </Typography>
          </Box>

          {/* Name column */}
          <Box className="file-browser-sort-column" sx={{ minWidth: 0 }}>
            <SortButton
              field="fileName"
              label="Name"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          </Box>

          {/* Date column */}
          <Box>
            <SortButton
              field="createdAt"
              label="Date"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          </Box>

          {/* Size column */}
          <Box>
            <SortButton
              field="fileSize"
              label="Size"
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          </Box>
        </Box>

        {/* Linear progress bar below header when loading */}
        {isLoading && (
          <Box
            className="file-browser-loading-bar"
            data-testid="file-browser-loader"
            sx={{ width: '100%', height: 3, mt: '16px' }}
          >
            <LinearProgress />
          </Box>
        )}
      </>
    );
  };

  // Always show sorting controls, even when there are no files
  const showEmptyState = files.length === 0 && !isLoading;

  if (viewType === 'grid') {
    return (
      <Box
        className="file-browser-list-container"
        sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        {/* Grid View Sorting Controls (header) */}
        {renderSortingControls()}

        {/* Tags Section */}
        {availableTagOptions && selectedTags && onTagsChange && (
          <Box className="file-browser-tag-filters" sx={{ mb: 3, flexShrink: 0 }}>
            <FileBrowserTagFilters
              options={availableTagOptions}
              value={selectedTags}
              onChange={onTagsChange}
              onClearAll={onClearAll}
            />
          </Box>
        )}

        {/* Scrollable grid container below header */}
        <Box
          className="file-browser-grid-container"
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            px: { xs: 1, md: 0 },
            pb: { xs: 4, md: 6 },
            ...scrollbarStyles,
          }}
        >
          {showEmptyState ? (
            <Typography
              className="file-browser-empty-state"
              level="body-sm"
              sx={{ textAlign: 'center', mt: 4, color: 'text.tertiary' }}
            >
              {emptyDescription}
            </Typography>
          ) : (
            <Grid
              data-testid="file-browser-grid"
              container
              spacing={{ xs: 1, sm: 1.5, md: 2 }}
              columns={{ xs: 12, sm: 18, md: 24 }}
              sx={{
                '& .MuiGrid-item': {
                  display: 'flex',
                  flexDirection: 'column',
                },
              }}
            >
              {files.map(file => (
                <FileBrowserItem key={file.id} file={file} viewType={viewType} tags={getTags(file)} />
              ))}
            </Grid>
          )}
        </Box>
        {/* Pagination Controls for Grid View - Outside scrollable area */}
        {onPageChange && totalPages > 1 && (
          <Box
            className="file-browser-pagination"
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 2,
              mt: 2,
              pt: 2,
              pb: 1,
              flexShrink: 0,
              borderTop: '1px solid',
              borderTopColor: 'divider',
              backgroundColor: theme => theme.palette.background.body,
            }}
          >
            <Button
              variant="outlined"
              disabled={currentPage === 1 || isLoading}
              onClick={() => onPageChange(currentPage - 1)}
              size="sm"
            >
              {t('file_browser.previous')}
            </Button>
            <Typography level="body-sm">
              {t('file_browser.page_of', { current: currentPage, total: totalPages })}
            </Typography>
            <Button
              variant="outlined"
              disabled={currentPage === totalPages || isLoading}
              onClick={() => onPageChange(currentPage + 1)}
              size="sm"
            >
              {t('file_browser.next')}
            </Button>
          </Box>
        )}
      </Box>
    );
  }

  // List View
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Sorting controls */}
      {renderSortingControls()}

      {/* Tags Section */}
      {availableTagOptions && selectedTags && onTagsChange && (
        <Box sx={{ mb: 3, flexShrink: 0 }}>
          <FileBrowserTagFilters
            options={availableTagOptions}
            value={selectedTags}
            onChange={onTagsChange}
            onClearAll={onClearAll}
          />
        </Box>
      )}

      {/* File list (flex: 1, scrollable) */}
      <Box
        className="file-browser-list-content"
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: '8px', md: '10px' },
          pr: { xs: 0, sm: 2 },
          pb: { xs: 4, md: 6 },
          ...scrollbarStyles,
        }}
      >
        {showEmptyState ? (
          <Typography level="body-sm" sx={{ textAlign: 'center', mt: 4, color: 'text.tertiary' }}>
            {emptyDescription}
          </Typography>
        ) : (
          files.map(file => <FileBrowserItem key={file.id} file={file} viewType={viewType} tags={getTags(file)} />)
        )}
      </Box>

      {/* Pagination Controls for List View - Outside scrollable area */}
      {onPageChange && totalPages > 1 && (
        <Box
          className="file-browser-pagination"
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 2,
            mt: 2,
            pt: 2,
            pb: 1,
            flexShrink: 0,
            borderTop: '1px solid',
            borderTopColor: 'divider',
            backgroundColor: theme => theme.palette.background.body,
          }}
        >
          <Button
            variant="outlined"
            disabled={currentPage === 1 || isLoading}
            onClick={() => onPageChange(currentPage - 1)}
            size="sm"
          >
            {t('file_browser.previous')}
          </Button>
          <Typography level="body-sm">
            {t('file_browser.page_of', { current: currentPage, total: totalPages })}
          </Typography>
          <Button
            variant="outlined"
            disabled={currentPage === totalPages || isLoading}
            onClick={() => onPageChange(currentPage + 1)}
            size="sm"
          >
            {t('file_browser.next')}
          </Button>
        </Box>
      )}
    </Box>
  );
};

// SortButton: interactive, shows correct icon and triggers sort
const SortButton: FC<{
  field: SortField;
  label: string;
  sortField: SortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: SortField) => void;
}> = ({ field, label, sortField, sortDirection, onSort }) => {
  const isActive = sortField === field;
  let icon = <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />;
  if (isActive) {
    icon =
      sortDirection === 'asc' ? (
        <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
      ) : (
        <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />
      );
  }
  return (
    <IconButton
      className="file-browser-sort-button"
      data-testid={`file-browser-sort-${field}-btn`}
      variant={isActive ? 'soft' : 'plain'}
      color={isActive ? 'primary' : 'neutral'}
      size="sm"
      onClick={() => onSort(field)}
      sx={{
        gap: 1,
        minHeight: '32px',
        minWidth: '80px',
        fontSize: '12px',
        bgcolor: isActive ? 'fileBrowser.buttons.activeBackgroundColor' : theme => theme.palette.fileBrowser.surface,
        border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
        borderColor: isActive
          ? 'fileBrowser.buttons.mainBlueBorderColor'
          : theme => theme.palette.neutral.outlinedBorder,
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          bgcolor: isActive
            ? 'fileBrowser.buttons.activeHoverBackgroundColor'
            : theme => theme.palette.notebooklist.hoverBg,
        },
        '& svg': {
          strokeWidth: 2,
          width: '16px',
          height: '16px',
        },
      }}
    >
      <Typography
        level="body-xs"
        sx={{ color: 'text.primary', fontSize: '14px', fontWeight: '400', marginRight: '-4px' }}
      >
        {label}
      </Typography>

      {icon}
    </IconButton>
  );
};

export default FileBrowserList;

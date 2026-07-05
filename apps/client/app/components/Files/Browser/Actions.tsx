import { IFileTag } from '@bike4mind/common';
import {
  Add,
  Close,
  DeleteOutline,
  LocalOffer,
  IosShare,
  CheckBox,
  ChevronLeft,
  ChevronRight,
} from '@mui/icons-material';
import { Box, Button, Dropdown, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { brand, red, redAlpha } from '@client/app/utils/themes/colors';

interface FileBrowserActionsProps {
  selectedCount: number;
  tags: IFileTag[];
  hasSelectedAll?: boolean;
  onSelectAll: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onShare: () => void;
  onTag: (tag: IFileTag) => Promise<void>;
  className?: string;
  // Pagination props
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  isLoadingPage?: boolean;
}

const FileBrowserActions: FC<FileBrowserActionsProps> = ({
  tags = [],
  selectedCount = 0,
  hasSelectedAll = false,
  onSelectAll,
  onDelete,
  onAdd,
  onShare,
  onTag,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  isLoadingPage = false,
}) => {
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();

  async function handleTagging(tag: IFileTag) {
    setLoading(true);
    await onTag(tag);
    setLoading(false);
  }

  return (
    <Box
      className="file-browser-actions-container"
      sx={{
        display: 'flex',
        gap: { xs: '8px', md: '16px' },
        flexWrap: 'wrap',
        marginLeft: 'auto',
        justifyContent: 'space-around',
        alignItems: 'center',
      }}
    >
      {/* Pagination Controls */}
      {onPageChange && totalPages > 1 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            data-testid="file-browser-prev-page-btn"
            variant="outlined"
            color="neutral"
            disabled={currentPage === 1 || isLoadingPage}
            onClick={() => onPageChange(currentPage - 1)}
            sx={{
              height: '32px',
              minWidth: '32px',
              padding: '0 8px',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '400',
              color: 'text.primary',
              '& .MuiSvgIcon-root': {
                width: '16px',
                height: '16px',
              },
              '&.MuiButton-root': {
                minHeight: '32px !important',
              },
              '&:hover': {
                backgroundColor: theme => theme.palette.notebooklist.hoverBg,
              },
            }}
          >
            <ChevronLeft />
            <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
              {t('file_browser.previous')}
            </Box>
          </Button>
          <Typography level="body-sm" sx={{ color: 'text.primary', fontSize: '14px', whiteSpace: 'nowrap' }}>
            {t('file_browser.page_of', { current: currentPage, total: totalPages })}
          </Typography>
          <Button
            data-testid="file-browser-next-page-btn"
            variant="outlined"
            color="neutral"
            disabled={currentPage === totalPages || isLoadingPage}
            onClick={() => onPageChange(currentPage + 1)}
            sx={{
              height: '32px',
              minWidth: '32px',
              padding: '0 8px',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '400',
              color: 'text.primary',
              '& .MuiSvgIcon-root': {
                width: '16px',
                height: '16px',
              },
              '&.MuiButton-root': {
                minHeight: '32px !important',
              },
              '&:hover': {
                backgroundColor: theme => theme.palette.notebooklist.hoverBg,
              },
            }}
          >
            <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
              {t('file_browser.next')}
            </Box>
            <ChevronRight />
          </Button>
        </Box>
      )}

      {/* Delete Button */}
      {selectedCount > 0 && (
        <Button
          data-testid="file-browser-delete-btn"
          variant="soft"
          onClick={onDelete}
          sx={{
            maxHeight: '32px',
            width: { xs: '32px', md: 'auto' },
            minWidth: { xs: '32px', md: 'auto' },
            padding: { xs: 0, md: '0 12px' },
            borderRadius: '8px',
            // text style
            fontSize: '14px',
            fontWeight: '400',
            color: 'fileBrowser.bottomDelete.textColor',

            border: `1px solid ${red[600]}`,
            bgcolor: redAlpha[600][10],

            '& .MuiSvgIcon-root, & svg': {
              width: '16px',
              height: '16px',
              marginRight: { xs: 0, md: '6px' },
            },

            // Override MUI defaults
            '&.MuiButton-root': {
              minHeight: '32px !important',
            },

            '&:hover': {
              backgroundColor: redAlpha[600][20],
              color: 'fileBrowser.bottomDelete.textColor',
            },
          }}
        >
          <DeleteOutline />
          <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
            {t('file_browser.delete_count_file', { count: selectedCount })}
          </Box>
        </Button>
      )}

      {/* Share Button */}
      {selectedCount > 0 && (
        <Button
          data-testid="file-browser-share-btn"
          variant="outlined"
          color="neutral"
          onClick={onShare}
          sx={{
            maxHeight: '32px',
            width: { xs: '32px', md: 'auto' },
            minWidth: { xs: '32px', md: 'auto' },
            padding: { xs: 0, md: '0 12px' },
            borderRadius: '8px',

            // text style
            fontSize: '14px',
            fontWeight: '400',
            color: 'text.primary',

            '& .MuiSvgIcon-root, & svg': {
              width: '16px',
              height: '16px',
              marginRight: { xs: 0, md: '6px' },
              color: 'text.primary',
            },

            // Override MUI defaults
            '&.MuiButton-root': {
              minHeight: '32px !important',
            },
            '&:hover': {
              backgroundColor: theme => theme.palette.notebooklist.hoverBg,
            },
          }}
        >
          <IosShare />
          <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
            {t('file_browser.share_count_file', { count: selectedCount })}
          </Box>
        </Button>
      )}

      {/* Tag Button */}
      {selectedCount > 0 && tags.length > 0 && (
        <Dropdown>
          <MenuButton
            data-testid="file-browser-tag-menu-btn"
            variant="outlined"
            color="neutral"
            sx={{
              maxHeight: '32px',
              width: { xs: '32px', md: 'auto' },
              minWidth: { xs: '32px', md: 'auto' },
              padding: { xs: 0, md: '0 12px' },
              borderRadius: '8px',

              // text style
              fontSize: '14px',
              fontWeight: '400',
              color: 'text.primary',

              // Override MUI defaults
              '& .MuiSvgIcon-root, & svg': {
                width: '16px',
                height: '16px',
                marginRight: { xs: 0, md: '6px' },
                color: 'text.primary',
              },
              '&.MuiButton-root': {
                minHeight: '32px !important',
                maxHeight: '32px !important',
                height: '32px !important',
              },
              '&.MuiMenuButton-root': {
                minHeight: '32px !important',
                maxHeight: '32px !important',
                height: '32px !important',
              },
              '&:hover': {
                backgroundColor: theme => theme.palette.notebooklist.hoverBg,
              },
            }}
            disabled={loading}
          >
            <LocalOffer />
            <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
              {loading ? t('file_browser.tagging') : t('file_browser.tag_files')}
            </Box>
          </MenuButton>
          <Menu
            data-testid="file-browser-tag-menu"
            sx={theme => ({
              zIndex: 1400,
              maxHeight: '300px',
              overflowY: 'scroll',
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
            placement="top-start"
            modifiers={[
              {
                name: 'flip',
                enabled: false,
              },
              {
                name: 'preventOverflow',
                options: {
                  altAxis: true,
                  tether: false,
                },
              },
            ]}
          >
            {tags.map(tag => (
              <MenuItem
                data-testid="file-browser-tag-menu-item"
                key={tag.name}
                onClick={() => handleTagging(tag)}
                sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}
              >
                <Box
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
                <Box>{tag.name}</Box>
              </MenuItem>
            ))}
          </Menu>
        </Dropdown>
      )}

      {/* Select All / Unselect All Button */}
      <Button
        data-testid="file-browser-select-all-btn"
        variant="outlined"
        color="neutral"
        onClick={onSelectAll}
        sx={{
          // text style
          fontSize: '14px',
          fontWeight: '400',
          color: 'text.primary',

          height: '32px',
          width: { xs: '32px', md: 'auto' },
          minWidth: { xs: '32px', md: 'auto' },
          padding: { xs: 0, md: '0 12px' },
          borderRadius: '8px',

          // Override MUI defaults
          '& .MuiSvgIcon-root, & svg': {
            width: '16px',
            height: '16px',
            marginRight: { xs: 0, md: '6px' },
            color: 'inherit',
          },
          '&.MuiButton-root': {
            minHeight: '32px !important',
          },
          '&:hover': {
            backgroundColor: theme => theme.palette.notebooklist.hoverBg,
          },
        }}
      >
        {/* Mobile icons - different based on selection state */}
        <Box component="span" sx={{ display: { xs: 'inline-flex', md: 'none' } }}>
          {selectedCount > 0 ? <Close /> : <CheckBox />}
        </Box>

        {/* Desktop icon - only when selected */}
        {selectedCount > 0 && (
          <Box component="span" sx={{ display: { xs: 'none', md: 'inline-flex' } }}>
            <Close />
          </Box>
        )}

        {/* Desktop text */}
        <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
          {selectedCount > 0 ? t('file_browser.unselect_all') : t('file_browser.select_all')}
        </Box>
      </Button>

      {/* Add Files Button */}
      <Button
        data-testid="file-browser-add-files-btn"
        onClick={onAdd}
        disabled={selectedCount === 0}
        sx={{
          height: '32px',
          width: { xs: '32px', md: 'auto' },
          minWidth: { xs: '32px', md: 'auto' },
          padding: { xs: 0, md: '0 12px' },
          borderRadius: '8px',

          // text style
          fontSize: '14px',
          lineHeight: '150%',

          // inactive vs active
          fontWeight: selectedCount === 0 ? '500' : '400',
          border: selectedCount === 0 ? '1px solid' : 'none',

          // inactive (light/dark) vs active
          color: selectedCount === 0 ? 'textColorfileBrowser.bottomAddDisabled.color' : 'white',
          bgcolor: selectedCount === 0 ? 'fileBrowser.bottomAddDisabled.backgroundColor' : brand[800],
          borderColor: selectedCount === 0 ? 'fileBrowser.bottomAddDisabled.borderColor' : 'none',

          // Override MUI defaults
          '& .MuiSvgIcon-root, & svg': {
            width: '16px',
            height: '16px',
            marginRight: { xs: 0, md: '6px' },
            color: 'inherit',
          },
          '&.MuiButton-root': {
            minHeight: '32px !important',
          },
          '&.Mui-disabled': {
            color: 'fileBrowser.bottomAddDisabled.color',
            backgroundColor: 'fileBrowser.bottomAddDisabled.backgroundColor',
            borderColor: 'fileBrowser.bottomAddDisabled.borderColor',
          },
        }}
      >
        <Add sx={{ strokeWidth: '2' }} />
        <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>
          {selectedCount > 0
            ? t('file_browser.add_files_to_notebook', { count: selectedCount })
            : t('file_browser.add_files')}
        </Box>
      </Button>
    </Box>
  );
};

export default FileBrowserActions;

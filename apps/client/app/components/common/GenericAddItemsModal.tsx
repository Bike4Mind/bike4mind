import {
  Box,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Typography,
  useTheme,
} from '@mui/joy';
import { useMediaQuery } from '@mui/system';
import { ReactNode, useCallback, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';

export interface GenericAddItemsModalProps<T> {
  // Basic props
  title: string;
  subtitle?: string;
  buttonLabel: string;
  buttonIcon?: ReactNode;

  // Data and selection
  items: T[];
  selectedIds: string[];
  onSelectIds: (ids: string[]) => void;
  getItemId: (item: T) => string;
  isItemDisabled?: (item: T) => boolean;

  // Search functionality
  onSearch?: (searchTerm: string) => void;
  searchPlaceholder?: string;

  // Actions
  onAdd: (ids: string[]) => void;
  isPending?: boolean;

  // Optional left grid content
  leftGridContent?: ReactNode;

  // Render props
  renderItem: (item: T, isSelected: boolean, onSelect: () => void) => ReactNode;
  renderNoResults?: (searchTerm: string) => ReactNode;

  // Scroll handling
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  isLoadingMore?: boolean;

  // Additional props
  modalWidth?: string | number;
  value?: string[];
  showButtonBadge?: boolean;
  searchMinLength?: number;
  triggerTestId?: string;
  testIdPrefix?: string;
}

function GenericAddItemsModal<T>({
  // Basic props
  title,
  subtitle,
  buttonLabel,
  buttonIcon = <AddIcon />,

  // Data and selection
  items,
  selectedIds,
  onSelectIds,
  getItemId,
  isItemDisabled,

  // Search functionality
  onSearch,
  searchPlaceholder = 'Search',

  // Actions
  onAdd,
  isPending = false,

  // Optional left grid content
  leftGridContent,

  // Render props
  renderItem,
  renderNoResults,

  // Scroll handling
  onScroll,
  isLoadingMore = false,

  // Additional props
  modalWidth = '950px',
  value,
  showButtonBadge = true,
  searchMinLength,
  triggerTestId,
  testIdPrefix = 'generic-add-items',
}: GenericAddItemsModalProps<T>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));

  const handleClose = useCallback(() => {
    setOpen(false);
    setSearchTerm('');
    if (onSearch) onSearch('');
  }, [onSearch]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchTerm(value);
      if (onSearch) onSearch(value);
    },
    [onSearch]
  );

  const disabledItemIds = useMemo(
    () => new Set(items.filter(item => isItemDisabled?.(item)).map(getItemId)),
    [items, isItemDisabled, getItemId]
  );

  const selectableSelectedIds = useMemo(
    () => selectedIds.filter(id => !disabledItemIds.has(id)),
    [selectedIds, disabledItemIds]
  );

  const handleSelectAll = useCallback(() => {
    if (selectableSelectedIds.length === items.length || selectableSelectedIds.length > 0) {
      // If all items are selected or any items are selected, unselect all
      onSelectIds([]);
    } else {
      // Otherwise, select all items
      onSelectIds(items.map(getItemId).filter(id => !disabledItemIds.has(id)));
    }
  }, [items, selectableSelectedIds, onSelectIds, getItemId, disabledItemIds]);

  const handleItemSelect = useCallback(
    (itemId: string) => {
      if (disabledItemIds.has(itemId)) return;
      if (selectableSelectedIds.includes(itemId)) {
        onSelectIds(selectableSelectedIds.filter(id => id !== itemId));
      } else {
        onSelectIds([...selectableSelectedIds, itemId]);
      }
    },
    [selectableSelectedIds, onSelectIds, disabledItemIds]
  );

  const handleAddItems = useCallback(() => {
    if (selectableSelectedIds.length === 0) return;
    onAdd(selectableSelectedIds);
    setOpen(false);
    if (onSearch) onSearch('');
  }, [onAdd, selectableSelectedIds, onSearch]);

  // Calculate responsive modal width
  const responsiveModalWidth = isMobile
    ? '95%'
    : isTablet
      ? '90%'
      : typeof modalWidth === 'number'
        ? `${Math.min(modalWidth, window.innerWidth * 0.95)}px`
        : modalWidth;

  return (
    <>
      <Button
        className="generic-add-items-modal-trigger"
        data-testid={triggerTestId}
        sx={{
          width: { xs: 'auto', sm: '190px' },
          fontSize: { xs: '0.875rem', sm: '1rem' },
          whiteSpace: 'nowrap',
        }}
        onClick={() => setOpen(true)}
      >
        {buttonIcon} {buttonLabel} {showButtonBadge && value?.length ? `(${value.length})` : ''}
      </Button>
      <Modal
        className="generic-add-items-modal"
        open={open}
        onClose={handleClose}
        sx={theme => ({
          '& ::-webkit-scrollbar-thumb': {
            backgroundColor: theme.palette.background.scrollbar,
            border: `2px solid ${theme.palette.background.scrollbarTrack}`,
            borderRadius: '20px',
          },
          '& ::-webkit-scrollbar': {
            width: '8px',
          },
          '& ::-webkit-scrollbar-track': {
            backgroundColor: theme.palette.background.scrollbarTrack,
          },
        })}
      >
        <ModalDialog
          className="generic-add-items-modal-dialog"
          data-testid={`${testIdPrefix}-modal`}
          sx={{
            width: responsiveModalWidth,
            maxWidth: '95vw',
            p: 0,
            gap: '0',
            maxHeight: '90vh',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <IconButton
            className="generic-add-items-modal-close-button"
            sx={{
              position: 'absolute',
              top: { xs: '5px', sm: '10px' },
              right: { xs: '5px', sm: '10px' },
            }}
            onClick={handleClose}
          >
            <CloseIcon />
          </IconButton>
          <DialogTitle
            className="generic-add-items-modal-title"
            sx={{
              px: { xs: '15px', sm: '30px' },
              py: { xs: '15px', sm: '30px' },
              flexDirection: 'column',
            }}
          >
            {title}
            {subtitle && (
              <Box fontSize={{ xs: '12px', sm: '14px' }} fontWeight="400">
                {subtitle}
              </Box>
            )}
          </DialogTitle>
          <DialogContent
            className="generic-add-items-modal-content"
            sx={{
              pl: { xs: '15px', sm: '30px' },
              ...(!leftGridContent && { pr: { xs: '15px', sm: '30px' } }),
              overflow: 'hidden',
            }}
          >
            <Stack gap={{ xs: '10px', sm: '20px' }} sx={{ overflowY: 'auto', overflowX: 'hidden', height: '100%' }}>
              {leftGridContent ? (
                <Grid container spacing={{ xs: '5px', sm: '10px' }} sx={{ pr: { xs: '15px', sm: '30px' } }}>
                  <Grid lg={6} md={6} sm={12} xs={12}>
                    {leftGridContent}
                  </Grid>
                  <Grid lg={6} md={6} sm={12} xs={12}>
                    {onSearch && (
                      <Input
                        sx={{ width: '100%' }}
                        placeholder={searchPlaceholder}
                        onChange={e => handleSearch(e.target.value)}
                        slotProps={{ input: { 'data-testid': `${testIdPrefix}-search-input` } }}
                        startDecorator={<SearchIcon />}
                      />
                    )}
                  </Grid>
                </Grid>
              ) : (
                onSearch && (
                  <Input
                    className="generic-add-items-modal-search-input"
                    sx={{ width: '100%', pr: { xs: '15px', sm: '30px' } }}
                    placeholder={searchPlaceholder}
                    onChange={e => handleSearch(e.target.value)}
                    slotProps={{ input: { 'data-testid': `${testIdPrefix}-search-input` } }}
                    startDecorator={<SearchIcon />}
                  />
                )
              )}
              <Box
                sx={{
                  overflowY: 'auto',
                  flexGrow: 1,
                  pb: { xs: '10px', sm: '20px' },
                  ...(leftGridContent && { pr: { xs: '15px', sm: '28px' } }),
                  height: isMobile ? 'calc(60vh - 120px)' : 'auto',
                }}
                onScroll={onScroll}
              >
                <Stack gap={{ xs: '5px', sm: '10px' }}>
                  {items.map(item => {
                    const itemId = getItemId(item);
                    const isSelected = selectableSelectedIds.includes(itemId);
                    return (
                      <Box
                        key={itemId}
                        onClick={() => handleItemSelect(itemId)}
                        aria-disabled={disabledItemIds.has(itemId)}
                        data-testid={`${testIdPrefix}-item`}
                      >
                        {renderItem(item, isSelected, () => handleItemSelect(itemId))}
                      </Box>
                    );
                  })}
                  {items.length === 0 && (
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        height: '100px',
                        color: 'text.secondary',
                      }}
                    >
                      {renderNoResults && searchTerm && (!searchMinLength || searchTerm.length >= searchMinLength) ? (
                        renderNoResults(searchTerm)
                      ) : (
                        <Typography level="body-lg" color="neutral">
                          {searchMinLength && searchTerm.length > 0 && searchTerm.length < searchMinLength
                            ? t('common.search_min_length', 'Type at least {{count}} characters to search.', {
                                count: searchMinLength,
                              })
                            : t('common.no_results_found', 'No results found')}
                        </Typography>
                      )}
                    </Box>
                  )}
                  {isLoadingMore && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                      <CircularProgress className="generic-add-items-modal-loading" size="sm" />
                    </Box>
                  )}
                </Stack>
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions
            sx={{
              p: { xs: '10px 15px', sm: '14px 30px' },
              border: '1px solid',
              borderColor: 'divider',
              flexDirection: { xs: 'column', sm: 'row' },
              gap: '10px',
              justifyContent: 'flex-end',
            }}
          >
            <Button
              className="generic-add-items-modal-select-all-button"
              data-testid={`${testIdPrefix}-select-all-btn`}
              variant="outlined"
              sx={{
                width: { xs: '100%', sm: '140px' },
                minHeight: { xs: '36px', sm: '32px' },
              }}
              onClick={handleSelectAll}
            >
              {selectableSelectedIds.length > 0
                ? t('projects.modals.generic.unselect_all')
                : t('projects.modals.generic.select_all')}
            </Button>
            <Button
              className="generic-add-items-modal-add-button"
              data-testid={`${testIdPrefix}-submit-btn`}
              sx={{
                minWidth: { xs: '100%', sm: '140px' },
                minHeight: { xs: '36px', sm: '32px' },
                gap: '5px',
              }}
              onClick={handleAddItems}
              disabled={isPending || selectableSelectedIds.length === 0}
            >
              {isPending ? <CircularProgress /> : <AddIcon />}{' '}
              {t('projects.modals.generic.add_items', { count: selectableSelectedIds.length })}
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}

export default GenericAddItemsModal;

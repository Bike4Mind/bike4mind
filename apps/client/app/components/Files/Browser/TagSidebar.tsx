import { IFileTag, ITag } from '@bike4mind/common';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Input,
  Stack,
  Typography,
  Tooltip,
  Dropdown,
  Menu,
  MenuButton,
  MenuItem,
  Modal,
  ModalDialog,
  ModalClose,
} from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import CloseIcon from '@mui/icons-material/Close';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { Search } from '@mui/icons-material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import { FC, useState, useMemo, useEffect, useRef } from 'react';
import { blackAlpha, brand, brandAlpha, greenAlpha } from '../../../utils/themes/colors';
import { useUpdateFileTag, useDeleteFileTag } from '@client/app/hooks/data/tag';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useUser } from '@client/app/contexts/UserContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import TagForm from '../../Tag/Form';

interface TagSidebarProps {
  tags: IFileTag[];
  isOpen: boolean;
  onToggle: () => void;
  onTagClick: (tagName: string) => void;
  onClearAllTags?: () => void;
  activeTags: string[];
  onCreateTag: () => void;
  selectedFileIds: Set<string>;
  onAddTagToFiles: (tagId: string, fileIds: string[]) => Promise<void>;
  onTagUpdated?: () => void;
  onTagDeleted?: () => void;
}

const TagSidebar: FC<TagSidebarProps> = ({
  tags,
  isOpen,
  onToggle,
  onTagClick,
  onClearAllTags,
  activeTags,
  onCreateTag,
  selectedFileIds,
  onAddTagToFiles,
  onTagUpdated,
  onTagDeleted,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'default' | 'name' | 'usage' | 'recent'>('default');
  const [editingTag, setEditingTag] = useState<IFileTag | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const currentUser = useUser(s => s.currentUser);
  const setCurrentUser = useUser(s => s.setCurrentUser);
  const { updatePreferences } = useUserSettings();

  // Derive favorites directly from server preferences; no local state needed
  const favoriteTags = useMemo(
    () => new Set<string>(currentUser?.preferences?.favoriteTags ?? []),
    [currentUser?.preferences?.favoriteTags]
  );

  const drawerRef = useRef<HTMLDivElement>(null);

  const { mutateAsync: updateTag, isPending: isPendingUpdate } = useUpdateFileTag();
  const { mutateAsync: deleteTag } = useDeleteFileTag();
  const confirm = useConfirmation();

  useEffect(() => {
    if (isOpen && drawerRef.current) {
      drawerRef.current.focus();
    }
  }, [isOpen]);

  const toggleFavorite = (tagId: string) => {
    const newFavorites = new Set(favoriteTags);
    if (newFavorites.has(tagId)) {
      newFavorites.delete(tagId);
    } else {
      newFavorites.add(tagId);
    }
    const favoriteTagsArray = Array.from(newFavorites);
    // Optimistically update the Zustand store so the UI reflects the change
    // immediately. updatePreferences only persists to the server (fire-and-forget)
    // and otherwise relies on a delayed WebSocket echo to refresh currentUser.
    if (currentUser) {
      setCurrentUser({
        ...currentUser,
        preferences: { ...currentUser.preferences, favoriteTags: favoriteTagsArray },
      });
    }
    updatePreferences({ favoriteTags: favoriteTagsArray });
  };

  const filteredAndSortedTags = useMemo(() => {
    const filtered = tags.filter(
      tag =>
        tag.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (tag.description && tag.description.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    switch (sortBy) {
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'usage':
        filtered.sort((a, b) => (b.fileCount || 0) - (a.fileCount || 0));
        break;
      case 'recent':
        filtered.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
        break;
      case 'default':
        // Sort by favorites first, then by recent activity
        filtered.sort((a, b) => {
          const aIsFavorite = favoriteTags.has(a.id);
          const bIsFavorite = favoriteTags.has(b.id);

          // If one is favorite and other isn't, favorite comes first
          if (aIsFavorite && !bIsFavorite) return -1;
          if (!aIsFavorite && bIsFavorite) return 1;

          // If both are favorites or both are not favorites, sort by recent activity
          return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
        });
        break;
    }

    return filtered;
  }, [tags, searchQuery, sortBy, favoriteTags]);

  // Group tags by usage frequency
  const usageGroups = useMemo(() => {
    const groups = {
      frequent: filteredAndSortedTags.filter(tag => (tag.fileCount || 0) >= 10),
      moderate: filteredAndSortedTags.filter(tag => (tag.fileCount || 0) >= 3 && (tag.fileCount || 0) < 10),
      light: filteredAndSortedTags.filter(tag => (tag.fileCount || 0) < 3),
    };
    return groups;
  }, [filteredAndSortedTags]);

  // Group tags for default sorting (favorites first)
  const favoriteGroups = useMemo(() => {
    const favoriteTagsList = filteredAndSortedTags.filter(tag => favoriteTags.has(tag.id));
    const nonFavoriteTagsList = filteredAndSortedTags.filter(tag => !favoriteTags.has(tag.id));

    return {
      favorites: favoriteTagsList,
      recent: nonFavoriteTagsList,
    };
  }, [filteredAndSortedTags, favoriteTags]);

  const handleAddTagToSelectedFiles = async (tag: IFileTag) => {
    if (selectedFileIds.size > 0) {
      await onAddTagToFiles(tag.id, Array.from(selectedFileIds));
    }
  };

  const handleEditTag = (tag: IFileTag) => {
    setEditingTag(tag);
    setShowEditModal(true);
  };

  const handleDeleteTag = async (tag: IFileTag) => {
    confirm({
      title: `Delete ${tag.name}`,
      description: 'Are you sure you want to delete this tag?',
      onOk: async () => {
        await deleteTag(tag.id);
      },
    });
  };

  // Shared props passed to every TagGroup instance
  const tagGroupSharedProps = {
    onTagClick,
    onAddToSelectedFiles: handleAddTagToSelectedFiles,
    hasSelectedFiles: selectedFileIds.size > 0,
    activeTags,
    onEditTag: handleEditTag,
    onDeleteTag: handleDeleteTag,
    favoriteTags,
    toggleFavorite,
  };

  // Renders the appropriate TagGroup layout based on the active sort mode
  function renderTagGroups(): React.ReactNode {
    switch (sortBy) {
      case 'default':
        return (
          <>
            {favoriteGroups.favorites.length > 0 && (
              <TagGroup
                className="tag-sidebar-favorites-group"
                title="Favorites"
                subtitle={`${favoriteGroups.favorites.length} tags`}
                icon=""
                tags={favoriteGroups.favorites}
                {...tagGroupSharedProps}
              />
            )}
            {favoriteGroups.recent.length > 0 && (
              <TagGroup
                className="tag-sidebar-recent-group"
                title="Recent"
                subtitle={`${favoriteGroups.recent.length} tags`}
                icon=""
                tags={favoriteGroups.recent}
                {...tagGroupSharedProps}
              />
            )}
          </>
        );
      case 'usage':
        return (
          <>
            {usageGroups.frequent.length > 0 && (
              <TagGroup
                className="tag-sidebar-frequent-group"
                title="Frequently Used"
                subtitle={`${usageGroups.frequent.length} tags`}
                icon=""
                tags={usageGroups.frequent}
                {...tagGroupSharedProps}
              />
            )}
            {usageGroups.moderate.length > 0 && (
              <TagGroup
                className="tag-sidebar-moderate-group"
                title="Moderately Used"
                subtitle={`${usageGroups.moderate.length} tags`}
                icon=""
                tags={usageGroups.moderate}
                {...tagGroupSharedProps}
              />
            )}
            {usageGroups.light.length > 0 && (
              <TagGroup
                className="tag-sidebar-light-group"
                title="Lightly Used"
                subtitle={`${usageGroups.light.length} tags`}
                icon=""
                tags={usageGroups.light}
                {...tagGroupSharedProps}
              />
            )}
          </>
        );
      case 'name':
      case 'recent':
        return (
          <TagGroup
            className="tag-sidebar-all-tags-group"
            title="All Tags"
            subtitle={`${filteredAndSortedTags.length} tags`}
            icon=""
            tags={filteredAndSortedTags}
            {...tagGroupSharedProps}
          />
        );
    }
  }

  return (
    <>
      {/* Backdrop/Overlay */}
      {isOpen && (
        <Box
          className="tag-sidebar-backdrop"
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: blackAlpha[0][30],
            zIndex: 1299,
            borderRadius: '8px',
          }}
          onClick={onToggle}
        />
      )}

      {/* Sidebar Panel */}
      <Box
        className="tag-sidebar-container"
        sx={{
          position: 'fixed',
          top: { xs: 0, md: '50%' },
          left: 0,
          height: { xs: '100dvh', md: '90vh' },
          width: { xs: '85vw', md: '400px' },
          transform: {
            xs: isOpen ? 'translateX(0)' : 'translateX(-100%)',
            md: isOpen ? 'translateY(-50%) translateX(0)' : 'translateY(-50%) translateX(-100%)',
          },
          transition: 'transform 0.3s ease-in-out',
          backgroundColor: 'background.surface',
          border: '1px solid',
          borderColor: 'border.solid',
          borderTopLeftRadius: { xs: 0, md: '8px' },
          borderBottomLeftRadius: { xs: 0, md: '8px' },
          overflow: 'hidden',
          zIndex: 1300,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: isOpen ? `0 4px 20px ${blackAlpha[0][15]}` : 'none',
          p: 2,
        }}
        onClick={e => {
          // Close drawer when clicking outside (on the blurred background)
          if (e.target === e.currentTarget) {
            onToggle();
          }
        }}
        tabIndex={-1}
        ref={drawerRef}
      >
        {/* Header */}
        <Box
          className="tag-sidebar-header-container"
          sx={{
            backgroundColor: 'background.surface',
            mb: 2.5,
            borderTopLeftRadius: '8px',
          }}
        >
          <Stack
            className="tag-sidebar-header-stack"
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 2 }}
          >
            <Stack direction="row" alignItems="center" gap={1}>
              <LocalOfferIcon sx={{ fontSize: 18 }} />
              <Typography level="title-md" sx={{ fontWeight: 500 }}>
                Tag Manager
              </Typography>
            </Stack>
            <IconButton
              className="tag-sidebar-close-button"
              size="sm"
              variant="plain"
              onClick={onToggle}
              sx={{
                width: '32px',
                height: '32px',
                minWidth: '32px',
                minHeight: '32px',
                maxWidth: '32px',
                maxHeight: '32px',
                padding: 0,
              }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>

          {/* Search and Create Button Row */}
          <Stack className="tag-sidebar-search-stack" direction="row" gap={1} alignItems="center">
            <Input
              className="tag-sidebar-search-input"
              placeholder="Search tags..."
              startDecorator={
                <Search
                  sx={theme => ({
                    width: '20px',
                    height: '20px',
                    color: 'grey',
                  })}
                />
              }
              endDecorator={
                searchQuery && (
                  <IconButton size="sm" variant="plain" onClick={() => setSearchQuery('')}>
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                )
              }
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              sx={theme => ({
                flexGrow: 1,
                minHeight: '32px',
                boxShadow: `0px 1px 50px 0px ${brandAlpha[700][3]}`,
                fontSize: '14px',
                fontWeight: '400',
                lineHeight: '100%',
                borderRadius: '6px',
                border: `1px solid ${theme.palette.border.input}`,
                background: theme.palette.fileBrowser.surface,
                color: theme.palette.searchbar.color,
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

            {/* Sort Button with Dropdown */}
            <Dropdown>
              <MenuButton
                className="tag-sidebar-sort-button"
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'outlined',
                    sx: {
                      width: '32px',
                      height: '32px',
                      minWidth: '32px',
                      minHeight: '32px',
                      maxWidth: '32px',
                      maxHeight: '32px',
                      padding: 0,
                      borderRadius: '6px',
                      border: '1px solid',
                      borderColor: 'border.solid',
                      backgroundColor: 'background.surface',
                      color: 'text.primary',
                      '&:hover': {
                        backgroundColor: 'notebooklist.hoverBg',
                      },
                      '& svg': {
                        width: '16px !important',
                        height: '16px !important',
                      },
                    },
                  },
                }}
              >
                <SwapVertIcon sx={{ fontSize: 16 }} />
              </MenuButton>
              <Menu
                className="tag-sidebar-sort-menu"
                placement="bottom"
                sx={{
                  zIndex: 1400,
                  minWidth: '120px',
                  padding: '4px',
                  borderRadius: '8px',
                  backgroundColor: 'background.surface',
                  boxShadow: 'var(--joy-shadow-md)',
                  '& .MuiMenuItem-root': {
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: '400',
                    '&:hover': {
                      backgroundColor: 'notebooklist.hoverBg',
                    },
                    '&.Mui-selected': {
                      backgroundColor: brandAlpha[800][10],
                      color: 'text.primary',
                      border: '1px solid',
                      borderColor: brandAlpha[800][50],
                      '&:hover': {
                        backgroundColor: brandAlpha[800][10],
                      },
                    },
                  },
                  '& .MuiMenuItem-root + .MuiMenuItem-root': {
                    marginTop: '4px',
                  },
                }}
              >
                <MenuItem
                  className="tag-sidebar-sort-default"
                  onClick={() => setSortBy('default')}
                  selected={sortBy === 'default'}
                >
                  Default
                </MenuItem>
                <MenuItem
                  className="tag-sidebar-sort-usage"
                  onClick={() => setSortBy('usage')}
                  selected={sortBy === 'usage'}
                >
                  Usage
                </MenuItem>
                <MenuItem
                  className="tag-sidebar-sort-name"
                  onClick={() => setSortBy('name')}
                  selected={sortBy === 'name'}
                >
                  Name
                </MenuItem>
                <MenuItem
                  className="tag-sidebar-sort-recent"
                  onClick={() => setSortBy('recent')}
                  selected={sortBy === 'recent'}
                >
                  Recent
                </MenuItem>
              </Menu>
            </Dropdown>

            {/* Create New Tag Button */}
            <Tooltip className="tag-sidebar-create-tooltip" title="Create a new tag" placement="top">
              <IconButton
                className="tag-sidebar-create-button"
                variant="outlined"
                onClick={onCreateTag}
                sx={theme => ({
                  width: '32px',
                  height: '32px',
                  minWidth: '32px',
                  minHeight: '32px',
                  maxWidth: '32px',
                  maxHeight: '32px',
                  padding: 0,
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: brand[800],
                  color: 'white',
                  '&:hover': {
                    backgroundColor: theme.palette.primary[600],
                  },
                })}
              >
                <Typography
                  className="tag-sidebar-create-icon"
                  sx={{ fontSize: '24px', fontWeight: '400', color: 'white' }}
                >
                  +
                </Typography>
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        {/* Action Bar */}
        {selectedFileIds.size > 0 && (
          <Box
            className="tag-sidebar-action-bar"
            sx={{
              p: 1.5,
              mb: 2,
              borderRadius: '8px',
              bgcolor: brandAlpha[800][10],
              border: `1px solid ${brandAlpha[800][50]}`,
            }}
          >
            <Typography
              className="tag-sidebar-selected-count"
              level="body-sm"
              sx={{ mb: 0.5, fontWeight: 500, color: 'text.primary' }}
            >
              {selectedFileIds.size} file(s) selected
            </Typography>
            <Typography
              className="tag-sidebar-selected-hint"
              level="body-xs"
              sx={{ color: 'text.primary', opacity: 0.5 }}
            >
              Click tags below to add them to selected files
            </Typography>
          </Box>
        )}

        {/* Tags Content */}
        <Box
          className="tag-sidebar-content-container"
          sx={{ flex: 1, overflow: 'auto', borderBottomLeftRadius: '8px' }}
        >
          {/* Active Filters */}
          {activeTags.length > 0 && (
            <Box className="tag-sidebar-active-filters-container" sx={{ mb: 2 }}>
              <Stack
                className="tag-sidebar-active-filters-header"
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: 1.5, px: 1, py: 0 }}
              >
                <Typography
                  className="tag-sidebar-active-tags-label"
                  level="body-sm"
                  sx={{ fontWeight: 500, color: 'text.primary', opacity: 0.5 }}
                >
                  Active Tags
                </Typography>
                <Button
                  className="tag-sidebar-clear-all-button"
                  variant="plain"
                  size="sm"
                  onClick={onClearAllTags}
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
                  Clear all
                </Button>
              </Stack>
              <Stack
                className="tag-sidebar-active-tags-stack"
                direction="row"
                gap={1}
                sx={{ flexWrap: 'wrap', px: 1, py: 0 }}
              >
                {activeTags.map(tagName => (
                  <Chip
                    className="tag-sidebar-active-tag"
                    key={tagName}
                    size="sm"
                    variant="soft"
                    onClick={() => onTagClick(tagName)}
                    endDecorator={<CloseIcon sx={{ fontSize: 12, opacity: 0.5 }} />}
                    sx={theme => ({
                      bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
                      border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
                    })}
                  >
                    {tagName}
                  </Chip>
                ))}
              </Stack>
            </Box>
          )}

          {/* Tag Groups */}
          {/* Tag Groups */}
          {renderTagGroups()}

          {filteredAndSortedTags.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                {searchQuery ? 'No tags found matching your search' : 'No tags available'}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Overlay for mobile */}
      {isOpen && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: blackAlpha[0][50],
            zIndex: 1299,
            display: { xs: 'block', md: 'none' },
          }}
          onClick={onToggle}
        />
      )}

      {/* Edit Tag Modal */}
      {showEditModal && (
        <Modal
          className="tag-sidebar-edit-modal"
          open={showEditModal}
          onClose={
            isPendingUpdate
              ? undefined
              : () => {
                  setShowEditModal(false);
                  setEditingTag(null);
                }
          }
        >
          <ModalDialog
            className="tag-sidebar-edit-modal-dialog"
            sx={{ width: '480px', maxHeight: '90vh', overflow: 'auto' }}
          >
            <Box
              className="tag-sidebar-edit-modal-content"
              style={{
                justifyContent: 'center',
                alignItems: 'center',
                display: 'flex',
                flexDirection: 'column',
                padding: '8px',
              }}
            >
              <ModalClose className="tag-sidebar-edit-modal-close" />

              <Typography
                level="title-lg"
                sx={{
                  color: 'text.primary',
                  fontWeight: '400',
                  size: '20px',
                  lineHeight: '150%',
                  margin: '8px 0px 8px 0px',
                }}
              >
                Edit Tag
              </Typography>

              <Typography
                level="body-sm"
                sx={{
                  color: 'fileBrowser.createTag.secondaryText',
                  fontWeight: '400',
                  size: '14px',
                  lineHeight: '130%',
                  mb: '8px',
                }}
              >
                Update your tag details.
              </Typography>

              <TagForm
                data={editingTag as ITag}
                onSubmit={tag => {
                  if (editingTag) {
                    updateTag({
                      ...editingTag,
                      ...tag,
                    }).then(() => {
                      setEditingTag(null);
                      setShowEditModal(false);
                    });
                  }
                }}
                submitting={isPendingUpdate}
              />
            </Box>
          </ModalDialog>
        </Modal>
      )}
    </>
  );
};

// Tag Group Component
interface TagGroupProps {
  title: string;
  subtitle: string;
  icon: string;
  tags: IFileTag[];
  onTagClick: (tagName: string) => void;
  onAddToSelectedFiles: (tag: IFileTag) => Promise<void>;
  hasSelectedFiles: boolean;
  activeTags: string[];
  onEditTag: (tag: IFileTag) => void;
  onDeleteTag: (tag: IFileTag) => void;
  favoriteTags: Set<string>;
  toggleFavorite: (tagId: string) => void;
  className?: string;
}

const TagGroup: FC<TagGroupProps> = ({
  className,
  title,
  subtitle,
  icon,
  tags,
  onTagClick,
  onAddToSelectedFiles,
  hasSelectedFiles,
  activeTags,
  onEditTag,
  onDeleteTag,
  favoriteTags,
  toggleFavorite,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  if (tags.length === 0) return null;

  return (
    <Box className={`${className} tag-group-container`} sx={{ mb: 2 }}>
      {/* Group Header */}
      <Button
        className="tag-group-header-button"
        variant="plain"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        sx={{
          width: '100%',
          justifyContent: 'space-between',
          mb: 1,
          p: 1,
          fontWeight: 500,
          '&:hover': {
            backgroundColor: theme => theme.palette.notebooklist.hoverBg,
          },
        }}
      >
        <Stack direction="row" alignItems="center" sx={{ flexGrow: 1 }}>
          <Typography level="body-sm" sx={{ fontWeight: 500, color: 'text.primary', opacity: 0.5 }}>
            {title}
          </Typography>
        </Stack>
        {isExpanded ? (
          <KeyboardArrowUpIcon sx={{ fontSize: 16, color: 'var(--joy-palette-text-primary)', opacity: 0.5 }} />
        ) : (
          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: 'var(--joy-palette-text-primary)', opacity: 0.5 }} />
        )}
      </Button>

      {/* Group Tags */}
      {isExpanded && (
        <Stack gap={1}>
          {tags.map(tag => (
            <TagItem
              key={tag.id}
              tag={tag}
              isActive={activeTags.includes(tag.name)}
              onClick={() => onTagClick(tag.name)}
              onAddToSelectedFiles={() => onAddToSelectedFiles(tag)}
              hasSelectedFiles={hasSelectedFiles}
              onEditTag={() => onEditTag(tag)}
              onDeleteTag={() => onDeleteTag(tag)}
              favoriteTags={favoriteTags}
              toggleFavorite={toggleFavorite}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
};

// Individual Tag Item Component
interface TagItemProps {
  tag: IFileTag;
  isActive: boolean;
  onClick: () => void;
  onAddToSelectedFiles: () => Promise<void>;
  hasSelectedFiles: boolean;
  onEditTag: () => void;
  onDeleteTag: () => void;
  favoriteTags: Set<string>;
  toggleFavorite: (tagId: string) => void;
}

const TagItem: FC<TagItemProps> = ({
  tag,
  isActive,
  onClick,
  onAddToSelectedFiles,
  hasSelectedFiles,
  onEditTag,
  onDeleteTag,
  favoriteTags,
  toggleFavorite,
}) => {
  const theme = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleAddToFiles = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      await onAddToSelectedFiles();
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEditTag();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteTag();
  };

  return (
    <Box
      className="tag-item-container"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        p: 1,
        borderRadius: '8px',
        border: '1px solid',
        borderColor: isActive ? greenAlpha[800][50] : theme.palette.fileBrowser.tagList.inactiveItemBorderColor,
        backgroundColor: theme.palette.fileBrowser.item.background,
        ...(isActive && {
          background: `linear-gradient(${greenAlpha[800][5]}, ${greenAlpha[800][5]}), ${theme.palette.fileBrowser.item.background}`,
        }),
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        minHeight: '36px',
        '&:hover': {
          backgroundColor: isActive
            ? 'fileBrowser.list.activeHoverBackgroundColor'
            : theme.palette.notebooklist.hoverBg,
        },
      })}
    >
      <Stack direction="row" alignItems="center" gap={1} sx={{ flex: 1, minWidth: 0 }}>
        {/* Tag Icon */}
        <Box
          className="tag-item-icon"
          sx={{
            width: '24px',
            height: '24px',
            borderRadius: '4px',
            backgroundColor: tag.color || brand[800],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '10px',
            flexShrink: 0,
          }}
        >
          {tag.icon || '🏷️'}
        </Box>

        {/* Tag Info - Name and file count on one line */}
        <Box className="tag-item-info" sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            className="tag-item-name"
            level="body-sm"
            sx={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'text.primary',
            }}
          >
            {tag.name}{' '}
            <span style={{ color: 'var(--joy-palette-text-primary)', opacity: 0.35 }}>({tag.fileCount || 0})</span>
          </Typography>
        </Box>

        {/* Right side buttons */}
        <Stack direction="row" alignItems="center" gap={1}>
          {/* 3-dot menu container - always reserve space */}
          <Box
            className="tag-item-menu-container"
            sx={{
              position: 'relative',
              width: '20px',
              height: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* 3-dot menu - only show on hover */}
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'plain',
                    sx: {
                      p: 0,
                      width: '20px',
                      height: '20px',
                      minWidth: '20px',
                      minHeight: '20px',
                      opacity: isHovered ? 0.6 : 0,
                      transition: 'opacity 0.2s',
                      pointerEvents: isHovered ? 'auto' : 'none',
                      '&:hover': {
                        opacity: 1,
                        backgroundColor: 'transparent',
                      },
                    },
                  },
                }}
                onClick={e => e.stopPropagation()}
              >
                <MoreVertIcon sx={{ fontSize: 16 }} />
              </MenuButton>
              <Menu placement="bottom-end" sx={{ zIndex: 99999, width: '200px' }} onClick={e => e.stopPropagation()}>
                <MenuItem
                  onClick={e => {
                    e.stopPropagation();
                    toggleFavorite(tag.id);
                  }}
                  sx={{ py: 1, mb: 0.125 }}
                >
                  <StarOutlineIcon
                    sx={{
                      fill: favoriteTags.has(tag.id) ? 'none' : 'var(--joy-palette-text-primary)',
                      color: 'var(--joy-palette-text-primary)',
                      opacity: 0.5,
                    }}
                  />
                  <Typography level="body-sm" sx={{ ml: 1, color: 'text.primary', fontSize: '16px' }}>
                    {favoriteTags.has(tag.id) ? 'Remove Favorite' : 'Add Favorite'}
                  </Typography>
                </MenuItem>
                <MenuItem onClick={handleEditClick} sx={{ py: 1, mb: 0.125 }}>
                  <EditIcon style={{ color: 'var(--joy-palette-text-primary)', opacity: 0.5 }} />
                  <Typography level="body-sm" sx={{ ml: 1, color: 'text.primary', fontSize: '16px' }}>
                    Edit
                  </Typography>
                </MenuItem>
                <MenuItem
                  onClick={handleDeleteClick}
                  sx={{
                    py: 1,
                    '&:hover': {
                      backgroundColor: 'var(--joy-palette-danger-softHover)',
                    },
                  }}
                  color="danger"
                >
                  <DeleteOutlineIcon sx={{ color: theme.palette.fileBrowser.tagList.deleteIconColor }} />
                  <Typography
                    level="body-sm"
                    sx={{
                      ml: 1,
                      color: theme.palette.fileBrowser.tagList.deleteIconColor,
                      fontSize: '16px',
                    }}
                  >
                    Delete
                  </Typography>
                </MenuItem>
              </Menu>
            </Dropdown>
          </Box>

          {/* Add to Selected Files Button */}
          {hasSelectedFiles && (
            <Tooltip title="Add tag to selected files">
              <IconButton
                className="tag-item-add-button"
                size="sm"
                variant="outlined"
                onClick={handleAddToFiles}
                loading={isLoading}
                sx={theme => ({
                  p: 0,
                  width: '20px',
                  height: '20px',
                  minWidth: '20px',
                  minHeight: '20px',
                  borderRadius: '4px',
                  border: 'none',
                  backgroundColor: brand[800],
                  color: 'white',
                  '&:hover': {
                    backgroundColor: theme.palette.primary[600],
                  },
                })}
              >
                <Typography sx={{ fontSize: '18px', fontWeight: '400', color: 'white' }}>+</Typography>
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
    </Box>
  );
};

export default TagSidebar;

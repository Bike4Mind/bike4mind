import React, { FC, useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Typography,
  LinearProgress,
  Checkbox,
  Dropdown,
  MenuButton,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Chip,
  Tooltip,
  CircularProgress,
  Input,
  Grid,
  Textarea,
  Modal,
  ModalDialog,
} from '@mui/joy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import ShareDocumentModal from './common/ShareModal';
import { InviteType } from '@bike4mind/common';
import { IFabFileDocument } from '@bike4mind/common';
import { IUserDocument, ISessionDocument } from '@bike4mind/common';
import ClearIcon from '@mui/icons-material/Clear';
import { userCanDeleteDoc, userCanShareDoc, userCanUpdateDoc } from '../utils/userPermission';
import { MoreVert } from '@mui/icons-material';
import PublicIcon from '@mui/icons-material/Public';
import { truncate } from 'lodash';
import { GetFileIcon } from '../utils/fabFileUtils';
import { usePublishShare } from '@client/app/hooks/usePublishShare';
import { publishFabFile } from '@client/app/utils/publishApi';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import SegmentIcon from '@mui/icons-material/Segment';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import VisibilityIcon from '@mui/icons-material/Visibility';
import EditIcon from '@mui/icons-material/Edit';
import FolderPlusIcon from '@mui/icons-material/CreateNewFolder';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import SettingsIcon from '@mui/icons-material/Settings';
import { useUser } from '../contexts/UserContext';
import { t } from 'i18next';
import { useDeleteFile } from '../hooks/data/fabFiles';
import { useTheme } from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import NoteIcon from '@mui/icons-material/Note';
import { toast } from 'react-hot-toast';
import { updateFileUtility } from '@client/app/utils/filesAPICalls';
import { useGetFabFiles } from '../hooks/data/fabFiles';
import { useFileViewerStore } from './layouts/Notebook/Sidenav/FileViewerWrapper';
import { useShallow } from 'zustand/react/shallow';
import { gray, grayAlpha, redAlpha } from '@client/app/utils/themes/colors';
import UsernameText from './common/UsernameText';
import { APP_NAME } from '@client/config/general';

interface FileListProps {
  fileList: IFabFileDocument[];
  totalFiles: number;
  tabIndex: number;
  viewMode: 'list' | 'grid';
  isLoading: boolean;
  selectedFiles: Set<string>;
  handleBulkAdd: () => void;
  handleBulkDelete: () => void;
  fileToShare: IFabFileDocument;
  setFileToShare: (file: IFabFileDocument | null) => void;
  currentUser: IUserDocument;
  currentSession: ISessionDocument | null;
  onUnselectAll: () => void;
  onFileScrolled: (e: React.UIEvent<HTMLDivElement>) => void;
  onSelect: (id: string) => void;
  onShare: (file: IFabFileDocument) => void;
  vectorThreshold: number;
  handleRename: (file: IFabFileDocument) => void;
  handleDelete: (fileId: string) => void;
  cloneFabFile: (file: IFabFileDocument) => void;
  openKnowledgeModal: (file: IFabFileDocument) => void;
  setFileToManageTags: (file: IFabFileDocument) => void;
  openPropertiesModal: (file: IFabFileDocument) => void;
  handleOpenChunkModal: (file: IFabFileDocument) => void;
  setOpenAddProjectModal: (fileId: string) => void;
  cloning: boolean;
  editMode: string | null;
  editedFileName: string;
  setEditedFileName: (editedFileName: string) => void;
  setEditMode: (id: string | null) => void;
  onRefresh: () => Promise<void>;
  addedFileIds?: Set<string>;
}

type FileItemProps = {
  file: IFabFileDocument;
  fileList: IFabFileDocument[];
  onSelect: (id: string) => void;
  onShare: (file: IFabFileDocument) => void;
  onPublishShare: (file: IFabFileDocument) => void;
  vectorThreshold: number;
  handleRename: (file: IFabFileDocument) => void;
  handleDelete: (fileId: string) => void;
  cloneFabFile: (file: IFabFileDocument) => void;
  openKnowledgeModal: (file: IFabFileDocument) => void;
  setFileToManageTags: (file: IFabFileDocument) => void;
  openPropertiesModal: (file: IFabFileDocument) => void;
  handleOpenChunkModal: (file: IFabFileDocument) => void;
  setOpenAddProjectModal: (fileId: string) => void;
  cloning: boolean;
  editMode: string | null;
  editedFileName: string;
  setEditedFileName: (editedFileName: string) => void;
  selectedFiles: Set<string>;
  setEditMode: (id: string | null) => void;
  onRefresh: () => Promise<void>;
  addedFileIds?: Set<string>;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const FileGrid = ({
  file,
  fileList,
  onSelect,
  vectorThreshold,
  onShare,
  onPublishShare,
  openKnowledgeModal,
  handleRename,
  handleDelete,
  cloneFabFile,
  setFileToManageTags,
  openPropertiesModal,
  handleOpenChunkModal,
  setOpenAddProjectModal,
  cloning,
  selectedFiles,
  editMode,
  editedFileName,
  setEditedFileName,
  setEditMode,
  onRefresh,
  addedFileIds,
}: FileItemProps) => {
  const isInProject = addedFileIds?.has(file.id) ?? false;
  const MAX_VISIBLE_TAGS = 3;
  const sortedTags = file.tags?.sort((a, b) => b.strength - a.strength) || [];
  const shownTags = sortedTags.slice(0, MAX_VISIBLE_TAGS);
  const remainingTags = sortedTags.length - shownTags.length;
  const sharedRecipients = file.users ?? [];
  const MAX_VISIBLE_RECIPIENTS = 3;
  const shownRecipients = sharedRecipients.slice(0, MAX_VISIBLE_RECIPIENTS);
  const remainingRecipients = sharedRecipients.length - shownRecipients.length;
  const recipientCount = sharedRecipients.length;
  const usersUndefined = (file as any).users === undefined;
  const { currentUser } = useUser();
  const canUpdate = (file: IFabFileDocument) => userCanUpdateDoc(currentUser, file);
  const canDelete = (file: IFabFileDocument) => userCanDeleteDoc(currentUser, file);
  const canShare = (file: IFabFileDocument) => userCanShareDoc(currentUser, file);
  const deleteFile = useDeleteFile();
  const [notesAnchorEl, setNotesAnchorEl] = useState<null | HTMLElement>(null);
  const [editedNotes, setEditedNotes] = useState(file.notes || '');
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [currentFileId, setCurrentFileId] = useState<string | null>(null);

  const handleNotesClick = (event: React.MouseEvent<HTMLElement>, file: IFabFileDocument) => {
    setNotesAnchorEl(event.currentTarget);
    setEditedNotes(file.notes || '');
    setCurrentFileId(file.id);
  };

  const handleNotesClose = () => {
    setNotesAnchorEl(null);
    setEditedNotes('');
    setCurrentFileId(null);
    setIsSavingNotes(false);
  };

  const handleSaveNotes = async () => {
    if (!currentFileId || !onRefresh) return;

    setIsSavingNotes(true);
    try {
      const currentFile = fileList.find(f => f.id === currentFileId);
      if (!currentFile) {
        throw new Error('File not found');
      }

      // Update requires all these fields, not just notes
      const updateData = {
        fileName: currentFile.fileName,
        mimeType: currentFile.mimeType,
        filePath: currentFile.filePath,
        fileSize: currentFile.fileSize,
        type: currentFile.type,
        notes: editedNotes,
      };

      const response = await updateFileUtility(currentFileId, updateData);

      if (response) {
        await onRefresh();
        toast.success(t('file_properties.notes_save_success'));
        handleNotesClose();
      }
    } catch (error) {
      console.error('Error saving notes:', error);
      toast.error(t('file_properties.notes_save_error'));
    } finally {
      setIsSavingNotes(false);
    }
  };

  return (
    <Box
      data-testid="file-browser-list-item"
      sx={theme => ({
        border: '1px solid',
        borderColor: selectedFiles.has(file.id)
          ? theme.palette.fileBrowser.fileGrid.checkbox.checked.border
          : theme.palette.fileBrowser.borderColor,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '12px',
        cursor: 'pointer',
        width: '98%',
        height: 'auto',
        minHeight: '140px',
        position: 'relative',
        '&:hover': {
          backgroundColor: selectedFiles.has(file.id)
            ? theme.palette.fileBrowser.fileGrid.checkbox.checked.hover
            : theme.palette.fileBrowser.fileGrid.hover,
        },
        transition: 'background-color 0.2s',
        borderRadius: '10px',
        backgroundColor: selectedFiles.has(file.id)
          ? theme.palette.fileBrowser.fileGrid.checkbox.checked.background
          : theme.palette.fileBrowser.fileGrid.background,
      })}
      onClick={() => onSelect(file.id)}
    >
      <Checkbox
        variant="outlined"
        checked={selectedFiles.has(file.id)}
        onChange={() => onSelect(file.id)}
        onClick={e => e.stopPropagation()}
        sx={theme => ({
          position: 'absolute',
          top: 7,
          left: 7,
          '& .MuiCheckbox-checkbox': {
            backgroundColor: theme.palette.neutral.solidBg,
          },
          '& .MuiSvgIcon-root': {
            fill: theme.palette.fileBrowser.fileGrid.checkbox.checked.icon,
            fontSize: '0.8rem',
          },
          '& .Mui-checked': {
            backgroundColor: 'transparent',
            borderColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.border,
          },
          '& .Mui-checked:hover': {
            backgroundColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.hover,
            scale: 1,
          },
        })}
      />
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { onClick: e => e.stopPropagation() } }}
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            '&:hover': {
              backgroundColor: 'action.hover',
            },
            '&:active': {
              backgroundColor: 'action.selected',
            },
            transition: 'background-color 0.2s',
          }}
        >
          <MoreVert />
        </MenuButton>
        <Menu sx={{ zIndex: 1400 }}>
          <MenuItem
            onClick={event => {
              event.stopPropagation();
              openKnowledgeModal(file);
            }}
          >
            <VisibilityIcon sx={{ mr: 1 }} /> {t('view')}
          </MenuItem>
          {canUpdate(file) && (
            <MenuItem
              onClick={event => {
                event.stopPropagation();
                handleRename(file);
              }}
            >
              <EditIcon sx={{ mr: 1 }} /> {t('rename')}
            </MenuItem>
          )}
          {canUpdate(file) && (
            <MenuItem
              onClick={event => {
                event.stopPropagation();
                cloneFabFile(file);
              }}
              disabled={cloning}
            >
              <ContentCopyIcon sx={{ mr: 1 }} /> {cloning ? <CircularProgress size="sm" /> : t('clone')}
            </MenuItem>
          )}
          {canDelete(file) && (
            <MenuItem
              onClick={event => {
                event.stopPropagation();
                handleDelete(file.id);
              }}
              disabled={deleteFile.isPending}
            >
              <DeleteForeverIcon sx={{ mr: 1 }} /> {t('delete')}
            </MenuItem>
          )}
          {canShare(file) && (
            <MenuItem onClick={() => onShare(file)}>
              <CompareArrowsIcon sx={{ mr: 1 }} /> {t('share')}
            </MenuItem>
          )}
          <MenuItem onClick={() => onPublishShare(file)} data-testid="file-publish-share">
            <PublicIcon sx={{ mr: 1 }} /> Publish to public link
          </MenuItem>
          {canUpdate(file) && (
            <MenuItem
              onClick={event => {
                event.stopPropagation();
                setFileToManageTags(file);
              }}
            >
              <LocalOfferIcon sx={{ mr: 1 }} /> {t('file_actions.tags')}
            </MenuItem>
          )}
          <MenuItem
            onClick={event => {
              event.stopPropagation();
              openPropertiesModal(file);
            }}
          >
            <SettingsIcon sx={{ mr: 1 }} /> {t('instructions.title')}
          </MenuItem>
          <MenuItem
            onClick={event => {
              event.stopPropagation();
              setOpenAddProjectModal(file.id);
            }}
          >
            <FolderPlusIcon sx={{ mr: 1 }} /> {t('projects.add_to_project')}
          </MenuItem>
          <MenuItem
            onClick={event => {
              event.stopPropagation();
              handleOpenChunkModal(file);
            }}
          >
            <SegmentIcon sx={{ mr: 1 }} />
            {t('file_actions.vectorize')}
          </MenuItem>
          <MenuItem
            onClick={event => {
              event.stopPropagation();
              handleNotesClick(event, file);
            }}
          >
            <IconButton
              size="sm"
              variant="plain"
              color={file.notes ? 'primary' : 'neutral'}
              onClick={event => {
                event.stopPropagation();
                handleNotesClick(event, file);
              }}
            >
              <NoteIcon />
            </IconButton>
            {file.notes ? t('file_actions.edit_notes') : t('file_actions.add_note')}
          </MenuItem>
        </Menu>
      </Dropdown>

      {/* debug: shared-user count overlay */}
      <Box
        sx={{
          position: 'absolute',
          bottom: 6,
          right: 6,
          px: 0.5,
          py: 0.2,
          borderRadius: '6px',
          border: '1px solid',
          borderColor: usersUndefined ? 'danger.outlinedBorder' : 'neutral.outlinedBorder',
          color: usersUndefined ? 'danger.plainColor' : 'neutral.plainColor',
          fontSize: '10px',
          opacity: 0.9,
          backgroundColor: 'background.surface',
        }}
      >
        U: {usersUndefined ? '-' : recipientCount}
      </Box>

      {/* File Icon/Preview Section */}
      <Box
        sx={{
          height: 'auto',
          minHeight: '70px',
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          overflow: 'hidden',
          py: 1,
        }}
      >
        <GetFileIcon file={file} size={35} previewSize={60} color={theme => theme.palette.fileBrowser.fileIconColor} />
      </Box>

      {/* File Section */}
      <Box sx={{ height: 'auto', minHeight: '60px', width: '100%' }}>
        {/* Filename Section */}

        {editMode === file.id ? (
          <Box sx={{ width: '100%' }}>
            <Input
              value={editedFileName}
              onClick={e => e.stopPropagation()}
              onChange={e => setEditedFileName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename(file);
                if (e.key === 'Escape') {
                  // Cancel editing without saving
                  setEditMode(null);
                }
              }}
              sx={{ maxWidth: 200, fontSize: '12px' }}
              endDecorator={
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="success"
                    onClick={() => handleRename(file)}
                    aria-label="Save"
                    sx={{
                      padding: '2px',
                      minWidth: '20px',
                      minHeight: '20px',
                    }}
                  >
                    <CheckIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={() => setEditMode(null)}
                    aria-label="Cancel"
                    sx={{
                      padding: '2px',
                      minWidth: '20px',
                      minHeight: '20px',
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              }
            />
          </Box>
        ) : (
          <Box
            sx={{
              height: 'auto',
              minHeight: '14px',
              width: '100%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Typography
              level="body-sm"
              sx={{
                textAlign: 'center',
                wordBreak: 'break-word',
                width: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                px: 1,
                fontWeight: 400,
                lineHeight: '19.6px',
                letterSpacing: '0%',
                fontSize: '14px',
                color: theme => theme.vars.palette.text.primary,
              }}
            >
              {truncate(file.fileName, { length: 50, omission: '...' })}
            </Typography>
          </Box>
        )}

        {/* File Size Section */}
        <Box
          sx={{
            height: 'auto',
            minHeight: '20px',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          <Typography
            level="body-xs"
            sx={{
              textAlign: 'center',
              color: theme => theme.palette.fileBrowser.fileSizeColor,
            }}
          >
            {formatFileSize(file.fileSize || 0)}
          </Typography>
          {file.notes && (
            <Typography
              level="body-xs"
              sx={{
                textAlign: 'center',
                color: theme => theme.palette.fileBrowser.fileSizeColor,
                fontStyle: 'italic',
                maxWidth: '90%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.notes}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Status Chips Section */}
      {(isInProject ||
        (file.fileSize && file.fileSize > vectorThreshold && (file.chunked || !file.vectorized)) ||
        shownTags.length > 0 ||
        shownRecipients.length > 0) && (
        <Box
          sx={{
            height: 'auto',
            minHeight: '50px',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
            mt: 3,
          }}
        >
          {/* In Project Chip */}
          {isInProject && (
            <Chip size="sm" variant="soft" color="success" sx={{ flexShrink: 0 }}>
              {t('file_browser.in_project')}
            </Chip>
          )}
          {/* Chunked Status Chip */}
          {file.fileSize && file.fileSize > vectorThreshold ? (
            file.chunked ? (
              <Tooltip title={`Chunks: ${file.chunkCount ?? 0}`}>
                <Chip
                  size="sm"
                  variant="soft"
                  color="warning"
                  sx={{
                    border: `1px solid ${gray[600]}`,
                  }}
                >
                  {t('file_actions.chunked')}
                </Chip>
              </Tooltip>
            ) : !file.vectorized ? (
              <Chip
                size="sm"
                variant="soft"
                color="neutral"
                sx={{
                  border: `1px solid ${gray[600]}`,
                }}
              >
                {t('file_actions.not_chunked')}
              </Chip>
            ) : null
          ) : null}

          {/* Tags */}
          {shownTags.length > 0 && (
            <Stack
              direction="row"
              flexWrap="wrap"
              justifyContent="center"
              sx={{
                px: 1,
                maxWidth: '100%',
                overflow: 'hidden',
                gap: '6px',
              }}
            >
              {shownTags.map(tag => (
                <Chip
                  key={tag.name}
                  size="sm"
                  variant="soft"
                  color="neutral"
                  sx={{
                    fontSize: '0.7rem',
                    maxWidth: '100%',
                    border: `1px solid ${gray[600]}`,
                  }}
                >
                  {truncate(tag.name, { length: 12, omission: '...' })}
                </Chip>
              ))}
              {remainingTags > 0 && (
                <Typography
                  level="body-sm"
                  sx={{
                    color: 'neutral.500',
                    fontSize: '0.7rem',
                  }}
                >
                  +{remainingTags}
                </Typography>
              )}
            </Stack>
          )}

          {/* Shared recipients */}
          {shownRecipients.length > 0 && (
            <Stack
              direction="row"
              flexWrap="wrap"
              justifyContent="center"
              sx={{
                px: 1,
                maxWidth: '100%',
                overflow: 'hidden',
                gap: '6px',
              }}
            >
              {shownRecipients.map((share, index) => (
                <UsernameText
                  key={`${share.userId}-${index}`}
                  id={share.userId as string}
                  useEmail
                  parent={props => (
                    <Chip
                      size="sm"
                      variant="soft"
                      color="primary"
                      sx={{
                        fontSize: '0.7rem',
                        maxWidth: '100%',
                        border: `1px solid ${gray[600]}`,
                      }}
                      {...props}
                    />
                  )}
                />
              ))}
              {remainingRecipients > 0 && (
                <Typography
                  level="body-sm"
                  sx={{
                    color: 'neutral.500',
                    fontSize: '0.7rem',
                  }}
                >
                  +{remainingRecipients}
                </Typography>
              )}
            </Stack>
          )}
        </Box>
      )}

      {/* recipient count debug */}

      <Modal
        open={Boolean(notesAnchorEl)}
        onClose={handleNotesClose}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ModalDialog
          variant="outlined"
          sx={{
            minWidth: 300,
            maxWidth: 500,
            p: 2,
          }}
        >
          <Stack spacing={2}>
            <Typography level="title-sm">{t('file_actions.notes')}</Typography>
            <Textarea
              minRows={3}
              value={editedNotes}
              onChange={e => setEditedNotes(e.target.value)}
              placeholder={t('file_actions.notes_placeholder')}
            />
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button variant="plain" color="neutral" onClick={handleNotesClose} disabled={isSavingNotes}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSaveNotes} loading={isSavingNotes} disabled={editedNotes === file.notes}>
                {t('common.save')}
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

const FileRow = ({
  file,
  fileList,
  index,
  vectorThreshold,
  onSelect,
  handleRename,
  handleDelete,
  cloneFabFile,
  openKnowledgeModal,
  setFileToManageTags,
  openPropertiesModal,
  handleOpenChunkModal,
  setOpenAddProjectModal,
  cloning,
  onShare,
  onPublishShare,
  editMode,
  editedFileName,
  setEditedFileName,
  selectedFiles,
  setEditMode,
  onRefresh,
  addedFileIds,
}: FileItemProps & { index: number }) => {
  const isInProject = addedFileIds?.has(file.id) ?? false;
  const MAX_VISIBLE_TAGS = 3;
  const sortedTags = file.tags?.sort((a, b) => b.strength - a.strength) || [];
  const shownTags = sortedTags.slice(0, MAX_VISIBLE_TAGS);
  const remainingTags = sortedTags.length - shownTags.length;
  const { currentUser } = useUser();
  const canUpdate = (file: IFabFileDocument) => userCanUpdateDoc(currentUser, file);
  const canDelete = (file: IFabFileDocument) => userCanDeleteDoc(currentUser, file);
  const canShare = (file: IFabFileDocument) => userCanShareDoc(currentUser, file);
  const deleteFile = useDeleteFile();

  return (
    <>
      <Box
        data-testid="sidenav-file-list-item"
        sx={theme => ({
          minHeight: { xs: 'auto', md: '64px' },
          p: { xs: 2, md: 1 },
          cursor: 'pointer',
          position: 'relative',
          backgroundColor: selectedFiles.has(file.id)
            ? theme.palette.fileBrowser.fileGrid.checkbox.checked.background
            : theme.palette.fileBrowser.fileGrid.background,
          '&:hover': {
            backgroundColor: selectedFiles.has(file.id)
              ? theme.palette.fileBrowser.fileGrid.checkbox.checked.hover
              : theme.palette.fileBrowser.fileGrid.hover,
          },
          transition: 'background-color 0.2s',
          border: '1px solid',
          borderColor: selectedFiles.has(file.id)
            ? theme.palette.fileBrowser.fileGrid.checkbox.checked.border
            : theme.palette.fileBrowser.borderColor,
          borderRadius: '8px',
          mb: 1,
          width: '100%',
        })}
        onClick={e => {
          if (e.target instanceof HTMLElement && e.target.classList.contains('MuiMenuItem-root')) {
            return;
          }
          onSelect(file.id);
        }}
      >
        {/* Desktop Layout */}
        <Grid
          container
          alignItems="center"
          justifyContent="center"
          sx={{
            height: '100%',
            display: { xs: 'none', md: 'flex' },
          }}
        >
          {/* Checkbox - Fixed width */}
          <Grid xs="auto" sx={{ width: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <Checkbox
              variant="outlined"
              checked={selectedFiles.has(file.id)}
              onChange={() => onSelect(file.id)}
              onClick={e => e.stopPropagation()}
              sx={theme => ({
                '& .MuiCheckbox-checkbox': {
                  backgroundColor: theme.palette.neutral.solidBg,
                },
                '& .MuiSvgIcon-root': {
                  fill: theme.palette.fileBrowser.fileGrid.checkbox.checked.icon,
                  fontSize: '0.8rem',
                },
                '& .Mui-checked': {
                  backgroundColor: 'transparent',
                  borderColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.border,
                },
                '& .Mui-checked:hover': {
                  backgroundColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.hover,
                  scale: 1,
                },
              })}
            />
          </Grid>

          {/* File Icon - Fixed width */}
          <Grid xs="auto" sx={{ width: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <GetFileIcon
              file={file}
              size={24}
              previewSize={40}
              color={theme => theme.palette.fileBrowser.fileIconColor}
            />
          </Grid>

          {/* Filename and Tags - Flexible width */}
          <Grid xs sx={{ overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
            {editMode === file.id ? (
              <Input
                value={editedFileName}
                onClick={e => e.stopPropagation()}
                onChange={e => setEditedFileName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRename(file);
                  if (e.key === 'Escape') {
                    // Cancel editing without saving
                    setEditMode(null);
                  }
                }}
                autoFocus
                sx={{ width: '500px', ml: 1 }}
                endDecorator={
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="success"
                      onClick={() => handleRename(file)}
                      aria-label="Save"
                      sx={{
                        padding: '2px',
                        minWidth: '20px',
                        minHeight: '20px',
                      }}
                    >
                      <CheckIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      onClick={() => setEditMode(null)}
                      aria-label="Cancel"
                      sx={{
                        padding: '2px',
                        minWidth: '20px',
                        minHeight: '20px',
                      }}
                    >
                      <CloseIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Box>
                }
              />
            ) : (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 1,
                  width: '100%',
                  overflow: 'hidden',
                  ml: 1,
                }}
              >
                {/* Filename */}
                <Typography
                  level="body-sm"
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: theme => theme.palette.text.primary,
                    flexShrink: 1,
                  }}
                >
                  {truncate(file.fileName, { length: 50, omission: '...' })}
                </Typography>

                {file.fileSize && file.fileSize > vectorThreshold ? (
                  file.chunked ? (
                    <Tooltip title={`Chunks: ${file.chunkCount ?? 0}`}>
                      <Chip
                        size="sm"
                        variant="soft"
                        color="warning"
                        sx={{ flexShrink: 0, border: `1px solid ${gray[600]}` }}
                      >
                        {t('file_actions.chunked')}
                      </Chip>
                    </Tooltip>
                  ) : !file.vectorized ? (
                    <Chip
                      size="sm"
                      variant="soft"
                      color="warning"
                      sx={{ flexShrink: 0, border: `1px solid ${gray[600]}` }}
                    >
                      {t('file_actions.not_chunked')}
                    </Chip>
                  ) : null
                ) : null}

                {/* Tags */}
                {shownTags.length > 0 && (
                  <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5, flexShrink: 0, flexWrap: 'nowrap' }}>
                    {shownTags.map(tag => (
                      <Chip
                        key={tag.name}
                        size="sm"
                        variant="soft"
                        color="neutral"
                        sx={{
                          fontSize: '0.75rem',
                          border: `1px solid ${gray[600]}`,
                          flexShrink: 0,
                        }}
                      >
                        {tag.name}
                      </Chip>
                    ))}
                    {remainingTags > 0 && (
                      <Typography
                        level="body-sm"
                        sx={{
                          color: 'neutral.500',
                          fontSize: '0.75rem',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        +{remainingTags}
                      </Typography>
                    )}
                  </Box>
                )}

                {/* In Project indicator */}
                {isInProject && (
                  <Chip size="sm" variant="soft" color="success" sx={{ flexShrink: 0 }}>
                    {t('file_browser.in_project')}
                  </Chip>
                )}
              </Box>
            )}
          </Grid>

          {/* File Type - Fixed width */}
          <Grid
            xs="auto"
            sx={{
              width: '250px',
              textAlign: 'right',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              mr: '15px',
            }}
          >
            <Tooltip title={file.mimeType}>
              <Typography
                level="body-xs"
                sx={{
                  color: 'text.primary50',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {file.mimeType}
              </Typography>
            </Tooltip>
          </Grid>

          {/* File Size - Fixed width */}
          <Grid
            xs="auto"
            sx={{
              width: '80px',
              textAlign: 'right',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              mr: '15px',
            }}
          >
            <Typography
              level="body-xs"
              sx={{
                color: 'text.primary50',
              }}
            >
              {formatFileSize(file.fileSize)}
            </Typography>
          </Grid>

          {/* Date - Fixed width */}
          <Grid
            xs="auto"
            sx={{
              width: '100px',
              textAlign: 'right',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              mr: '15px',
            }}
          >
            <Typography
              level="body-xs"
              sx={{
                color: 'text.primary50',
              }}
            >
              {new Date(file.createdAt).toLocaleDateString(undefined, {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })}
            </Typography>
          </Grid>

          {/* Shared recipients - Fixed width, before actions */}
          <Grid
            xs="auto"
            sx={{
              maxWidth: '240px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 0.5,
              mr: '10px',
              overflow: 'hidden',
            }}
          >
            {(file.users?.length ?? 0) > 0 && (
              <Box sx={{ display: 'flex', gap: 0.5, overflow: 'hidden', flexWrap: 'nowrap' }}>
                {file.users!.slice(0, 3).map((share, index) => (
                  <UsernameText
                    key={`${share.userId}-${index}`}
                    id={share.userId as string}
                    useEmail
                    parent={props => (
                      <Chip
                        size="sm"
                        variant="soft"
                        color="primary"
                        sx={{
                          fontSize: '0.65rem',
                          border: `1px solid ${gray[600]}`,
                          maxWidth: '120px',
                        }}
                        {...props}
                      />
                    )}
                  />
                ))}
                {file.users!.length - 3 > 0 && (
                  <Typography level="body-sm" sx={{ color: 'neutral.500', fontSize: '0.65rem', whiteSpace: 'nowrap' }}>
                    +{file.users!.length - 3}
                  </Typography>
                )}
              </Box>
            )}
          </Grid>

          {/* Actions - Fixed width */}
          <Grid xs="auto" sx={{ width: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: { onClick: e => e.stopPropagation() } }}
                sx={{
                  '&:hover': {
                    backgroundColor: 'action.hover',
                  },
                  '&:active': {
                    backgroundColor: 'action.selected',
                  },
                  transition: 'background-color 0.2s',
                }}
              >
                <MoreVert />
              </MenuButton>
              <Menu sx={{ zIndex: 1400 }}>
                <MenuItem
                  onClick={event => {
                    event.stopPropagation();
                    openKnowledgeModal(file);
                  }}
                >
                  <VisibilityIcon sx={{ mr: 1 }} /> {t('view')}
                </MenuItem>
                {canUpdate(file) && (
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      handleRename(file);
                    }}
                  >
                    <EditIcon sx={{ mr: 1 }} /> {t('rename')}
                  </MenuItem>
                )}
                {canUpdate(file) && (
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      cloneFabFile(file);
                    }}
                    disabled={cloning}
                  >
                    <ContentCopyIcon sx={{ mr: 1 }} /> {cloning ? <CircularProgress size="sm" /> : t('clone')}
                  </MenuItem>
                )}
                {canDelete(file) && (
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      handleDelete(file.id);
                    }}
                    disabled={deleteFile.isPending}
                  >
                    <DeleteForeverIcon sx={{ mr: 1 }} /> {t('delete')}
                  </MenuItem>
                )}
                {canShare(file) && (
                  <MenuItem onClick={() => onShare(file)}>
                    <CompareArrowsIcon sx={{ mr: 1 }} /> {t('share')}
                  </MenuItem>
                )}
                <MenuItem onClick={() => onPublishShare(file)} data-testid="file-publish-share">
                  <PublicIcon sx={{ mr: 1 }} /> Publish to public link
                </MenuItem>
                {canUpdate(file) && (
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      setFileToManageTags(file);
                    }}
                  >
                    <LocalOfferIcon sx={{ mr: 1 }} /> {t('file_actions.tags')}
                  </MenuItem>
                )}
                <MenuItem
                  onClick={event => {
                    event.stopPropagation();
                    openPropertiesModal(file);
                  }}
                >
                  <SettingsIcon sx={{ mr: 1 }} /> {t('instructions.title')}
                </MenuItem>
                <MenuItem
                  onClick={event => {
                    event.stopPropagation();
                    setOpenAddProjectModal(file.id);
                  }}
                >
                  <FolderPlusIcon sx={{ mr: 1 }} /> {t('projects.add_to_project')}
                </MenuItem>
                <MenuItem
                  onClick={event => {
                    event.stopPropagation();
                    handleOpenChunkModal(file);
                  }}
                >
                  <SegmentIcon sx={{ mr: 1 }} />
                  {t('file_actions.vectorize')}
                </MenuItem>
              </Menu>
            </Dropdown>
          </Grid>
        </Grid>

        {/* Mobile Layout */}
        <Box sx={{ display: { xs: 'flex', md: 'none' }, flexDirection: 'column', gap: 1 }}>
          {/* First Row - Icon, Filename, and Actions */}
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            {/* Checkbox */}
            <Box sx={{ flexShrink: 0, mt: 0.5 }}>
              <Checkbox
                variant="outlined"
                checked={selectedFiles.has(file.id)}
                onChange={() => onSelect(file.id)}
                onClick={e => e.stopPropagation()}
                sx={theme => ({
                  '& .MuiCheckbox-checkbox': {
                    backgroundColor: theme.palette.neutral.solidBg,
                  },
                  '& .MuiSvgIcon-root': {
                    fill: theme.palette.fileBrowser.fileGrid.checkbox.checked.icon,
                    fontSize: '0.8rem',
                  },
                  '& .Mui-checked': {
                    backgroundColor: 'transparent',
                    borderColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.border,
                  },
                  '& .Mui-checked:hover': {
                    backgroundColor: theme.palette.fileBrowser.fileGrid.checkbox.checked.hover,
                    scale: 1,
                  },
                })}
              />
            </Box>

            {/* File Icon */}
            <Box sx={{ flexShrink: 0, mt: 0.5 }}>
              <GetFileIcon
                file={file}
                size={32}
                previewSize={40}
                color={theme => theme.palette.fileBrowser.fileIconColor}
              />
            </Box>

            {/* Filename and editing */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {editMode === file.id ? (
                <Input
                  value={editedFileName}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setEditedFileName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename(file);
                    if (e.key === 'Escape') {
                      setEditMode(null);
                    }
                  }}
                  autoFocus
                  sx={{ width: '100%' }}
                  endDecorator={
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="success"
                        onClick={() => handleRename(file)}
                        aria-label="Save"
                        sx={{
                          padding: '2px',
                          minWidth: '20px',
                          minHeight: '20px',
                        }}
                      >
                        <CheckIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => setEditMode(null)}
                        aria-label="Cancel"
                        sx={{
                          padding: '2px',
                          minWidth: '20px',
                          minHeight: '20px',
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Box>
                  }
                />
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  <Typography
                    level="body-sm"
                    sx={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: theme => theme.palette.text.primary,
                      fontWeight: 500,
                    }}
                  >
                    {truncate(file.fileName, { length: 35, omission: '...' })}
                  </Typography>

                  {/* File info row */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.primary50',
                        fontSize: '0.7rem',
                      }}
                    >
                      {file.mimeType}
                    </Typography>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.primary50',
                        fontSize: '0.7rem',
                      }}
                    >
                      •
                    </Typography>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.primary50',
                        fontSize: '0.7rem',
                      }}
                    >
                      {formatFileSize(file.fileSize)}
                    </Typography>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.primary50',
                        fontSize: '0.7rem',
                      }}
                    >
                      •
                    </Typography>
                    <Typography
                      level="body-xs"
                      sx={{
                        color: 'text.primary50',
                        fontSize: '0.7rem',
                      }}
                    >
                      {new Date(file.createdAt).toLocaleDateString(undefined, {
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                    </Typography>
                  </Box>
                </Box>
              )}
            </Box>

            {/* Actions */}
            <Box sx={{ flexShrink: 0 }}>
              <Dropdown>
                <MenuButton
                  slots={{ root: IconButton }}
                  slotProps={{ root: { onClick: e => e.stopPropagation() } }}
                  sx={{
                    '&:hover': {
                      backgroundColor: 'action.hover',
                    },
                    '&:active': {
                      backgroundColor: 'action.selected',
                    },
                    transition: 'background-color 0.2s',
                  }}
                >
                  <MoreVert />
                </MenuButton>
                <Menu sx={{ zIndex: 1400 }}>
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      openKnowledgeModal(file);
                    }}
                  >
                    <VisibilityIcon sx={{ mr: 1 }} /> {t('view')}
                  </MenuItem>
                  {canUpdate(file) && (
                    <MenuItem
                      onClick={event => {
                        event.stopPropagation();
                        handleRename(file);
                      }}
                    >
                      <EditIcon sx={{ mr: 1 }} /> {t('rename')}
                    </MenuItem>
                  )}
                  {canUpdate(file) && (
                    <MenuItem
                      onClick={event => {
                        event.stopPropagation();
                        cloneFabFile(file);
                      }}
                      disabled={cloning}
                    >
                      <ContentCopyIcon sx={{ mr: 1 }} /> {cloning ? <CircularProgress size="sm" /> : t('clone')}
                    </MenuItem>
                  )}
                  {canDelete(file) && (
                    <MenuItem
                      onClick={event => {
                        event.stopPropagation();
                        handleDelete(file.id);
                      }}
                      disabled={deleteFile.isPending}
                    >
                      <DeleteForeverIcon sx={{ mr: 1 }} /> {t('delete')}
                    </MenuItem>
                  )}
                  {canShare(file) && (
                    <MenuItem onClick={() => onShare(file)}>
                      <CompareArrowsIcon sx={{ mr: 1 }} /> {t('share')}
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => onPublishShare(file)} data-testid="file-publish-share">
                    <PublicIcon sx={{ mr: 1 }} /> Publish to public link
                  </MenuItem>
                  {canUpdate(file) && (
                    <MenuItem
                      onClick={event => {
                        event.stopPropagation();
                        setFileToManageTags(file);
                      }}
                    >
                      <LocalOfferIcon sx={{ mr: 1 }} /> {t('file_actions.tags')}
                    </MenuItem>
                  )}
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      openPropertiesModal(file);
                    }}
                  >
                    <SettingsIcon sx={{ mr: 1 }} /> {t('instructions.title')}
                  </MenuItem>
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      setOpenAddProjectModal(file.id);
                    }}
                  >
                    <FolderPlusIcon sx={{ mr: 1 }} /> {t('projects.add_to_project')}
                  </MenuItem>
                  <MenuItem
                    onClick={event => {
                      event.stopPropagation();
                      handleOpenChunkModal(file);
                    }}
                  >
                    <SegmentIcon sx={{ mr: 1 }} />
                    {t('file_actions.vectorize')}
                  </MenuItem>
                </Menu>
              </Dropdown>
            </Box>
          </Box>

          {/* Second Row - Status and Tags */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', ml: 5 }}>
            {/* In Project indicator */}
            {isInProject && (
              <Chip size="sm" variant="soft" color="success" sx={{ flexShrink: 0, fontSize: '0.65rem' }}>
                {t('file_browser.in_project')}
              </Chip>
            )}

            {/* Status Chips */}
            {file.fileSize && file.fileSize > vectorThreshold ? (
              file.chunked ? (
                <Tooltip title={`Chunks: ${file.chunkCount ?? 0}`}>
                  <Chip
                    size="sm"
                    variant="soft"
                    color="warning"
                    sx={{ flexShrink: 0, border: `1px solid ${gray[600]}`, fontSize: '0.65rem' }}
                  >
                    {t('file_actions.chunked')}
                  </Chip>
                </Tooltip>
              ) : !file.vectorized ? (
                <Chip
                  size="sm"
                  variant="soft"
                  color="warning"
                  sx={{ flexShrink: 0, border: `1px solid ${gray[600]}`, fontSize: '0.65rem' }}
                >
                  {t('file_actions.not_chunked')}
                </Chip>
              ) : null
            ) : null}

            {/* Tags */}
            {shownTags.length > 0 && (
              <>
                {shownTags.map(tag => (
                  <Chip
                    key={tag.name}
                    size="sm"
                    variant="soft"
                    color="neutral"
                    sx={{
                      fontSize: '0.65rem',
                      border: `1px solid ${gray[600]}`,
                      flexShrink: 0,
                    }}
                  >
                    {tag.name}
                  </Chip>
                ))}
                {remainingTags > 0 && (
                  <Typography
                    level="body-sm"
                    sx={{
                      color: 'neutral.500',
                      fontSize: '0.65rem',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    +{remainingTags}
                  </Typography>
                )}
              </>
            )}
          </Box>
        </Box>
      </Box>
      {/* debug: shared-count row */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, mt: 0.5 }}>
        <Typography level="body-xs" sx={{ color: theme => theme.palette.fileBrowser.fileSizeColor }}>
          Shared to: {file.users?.length ?? 0}
        </Typography>
      </Box>
    </>
  );
};

const FileList: FC<FileListProps> = ({
  fileList,
  totalFiles = 0,
  tabIndex,
  viewMode,
  isLoading,
  selectedFiles,
  handleBulkAdd,
  handleBulkDelete,
  fileToShare,
  setFileToShare,
  currentUser,
  currentSession,
  onUnselectAll,
  onFileScrolled,
  onSelect,
  onShare,
  vectorThreshold,
  handleRename,
  handleDelete,
  cloneFabFile,
  openKnowledgeModal,
  setFileToManageTags,
  openPropertiesModal,
  handleOpenChunkModal,
  setOpenAddProjectModal,
  cloning,
  editMode,
  editedFileName,
  setEditedFileName,
  setEditMode,
  onRefresh,
  addedFileIds,
}) => {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  // Public publish-and-share for a file -> /p/f/{publicId} + social bar.
  const { publishAndShare, modal: publishShareModal } = usePublishShare();
  const handlePublishShare = useCallback(
    (file: IFabFileDocument) => {
      void publishAndShare({
        publish: visibility => publishFabFile({ fabFileId: file.id, visibility }),
        // brand externalized
        title: file.fileName || (APP_NAME ? `Shared from ${APP_NAME}` : 'Shared'),
      });
    },
    [publishAndShare]
  );

  const canUpdateOrNewSession = useMemo(() => {
    if (currentSession) {
      return userCanUpdateDoc(currentUser, currentSession);
    }

    return true;
  }, [currentSession, currentUser]);

  const darkInactive = {
    '&:disabled': {
      border: `1px solid ${grayAlpha[710][50]}`,
      background: gray[650],
      color: gray[200],
      opacity: 0.3,

      '& .MuiSvgIcon-root': {
        fill: gray[200],
      },
    },
  };

  const lightInactive = {
    '&:disabled': {
      border: `1px solid ${gray[160]}`,
      background: gray[12],
      opacity: 0.3,

      '& .MuiSvgIcon-root': {
        fill: theme.palette.primary.solidDisabledColor,
      },
    },
  };

  const [search, sortOrder, filters, sortField] = useFileViewerStore(
    useShallow(s => [s.search, s.sort, s.filters, s.sortField])
  );
  const {
    data: paginatedFabFiles,
    isLoading: isLoadingFromHook,
    isFetching,
  } = useGetFabFiles(search, filters, sortOrder, sortField);
  const fabFiles = useMemo(
    () => paginatedFabFiles?.pages?.flatMap((page: any) => page.data) ?? [],
    [paginatedFabFiles]
  );

  // Use hook loading state for initial load, prop loading state for external control
  const effectiveIsLoading = isLoadingFromHook || isLoading;

  return (
    <>
      <Box
        sx={{
          maxHeight: '60vh',
          overflowY: 'auto',
          paddingBottom: '50px',
        }}
        onScroll={onFileScrolled}
      >
        {effectiveIsLoading ? (
          <Box sx={{ width: '100%', height: 3 }}>
            <LinearProgress />
          </Box>
        ) : fabFiles.length > 0 ? (
          viewMode === 'list' ? (
            fabFiles.map((file: IFabFileDocument, index: number) => (
              <FileRow
                key={file.id}
                file={file}
                fileList={fabFiles}
                index={index}
                selectedFiles={selectedFiles}
                onSelect={onSelect}
                onShare={onShare}
                onPublishShare={handlePublishShare}
                vectorThreshold={vectorThreshold}
                handleRename={handleRename}
                handleDelete={handleDelete}
                cloneFabFile={cloneFabFile}
                openKnowledgeModal={openKnowledgeModal}
                setFileToManageTags={setFileToManageTags}
                openPropertiesModal={openPropertiesModal}
                handleOpenChunkModal={handleOpenChunkModal}
                setOpenAddProjectModal={setOpenAddProjectModal}
                cloning={cloning}
                editMode={editMode}
                editedFileName={editedFileName}
                setEditedFileName={setEditedFileName}
                setEditMode={setEditMode}
                onRefresh={onRefresh}
                addedFileIds={addedFileIds}
              />
            ))
          ) : (
            <Box
              data-testid="file-browser-grid"
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: 'repeat(auto-fill, minmax(150px, 1fr))',
                  sm: 'repeat(auto-fill, minmax(180px, 1fr))',
                  md: 'repeat(auto-fill, minmax(210px, 1fr))',
                },
                gridAutoRows: 'auto',
                gap: { xs: 0.5, md: 1 },
                backgroundColor: theme.palette.background.surface,
                '@supports (grid-template-rows: masonry)': {
                  gridTemplateRows: 'masonry',
                },
              }}
            >
              {fabFiles.map((file: IFabFileDocument) => (
                <FileGrid
                  key={file.id}
                  file={file}
                  fileList={fabFiles}
                  selectedFiles={selectedFiles}
                  onSelect={onSelect}
                  onShare={onShare}
                  onPublishShare={handlePublishShare}
                  vectorThreshold={vectorThreshold}
                  handleRename={handleRename}
                  handleDelete={handleDelete}
                  cloneFabFile={cloneFabFile}
                  setFileToManageTags={setFileToManageTags}
                  openKnowledgeModal={openKnowledgeModal}
                  openPropertiesModal={openPropertiesModal}
                  handleOpenChunkModal={handleOpenChunkModal}
                  setOpenAddProjectModal={setOpenAddProjectModal}
                  cloning={cloning}
                  editedFileName={editedFileName}
                  setEditedFileName={setEditedFileName}
                  editMode={editMode}
                  setEditMode={setEditMode}
                  onRefresh={onRefresh}
                  addedFileIds={addedFileIds}
                />
              ))}
            </Box>
          )
        ) : (
          <Typography level="body-sm" sx={{ textAlign: 'center', mt: 4, color: 'text.tertiary' }}>
            {t('file_browser.no_files_available')}
          </Typography>
        )}

        {/* Pagination loading indicator */}
        {isFetching && !effectiveIsLoading && fabFiles.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <CircularProgress size="sm" />
          </Box>
        )}
      </Box>

      <Box
        sx={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          pt: 2.5,
          pb: 0,
          px: 2,
          backgroundColor: 'background.surface',
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography>{t('file_browser.count_file_selected', { count: selectedFiles.size })}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {tabIndex === 0 && (
            <Button
              onClick={handleBulkDelete}
              color="danger"
              variant="solid"
              sx={{
                fontWeight: '500',
                width: '180px',
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                color: theme.palette.fileBrowser.instructionChip.dangerColor,
                backgroundColor: theme.vars.palette.danger.softBg,
                border: '1px solid',
                borderColor: theme.vars.palette.danger.solidBg,
                '&:hover': {
                  backgroundColor: redAlpha[600][20],
                  borderColor: theme.vars.palette.danger.solidBg,
                },
                '& .MuiSvgIcon-root': {
                  fill: theme.palette.fileBrowser.instructionChip.dangerColor,
                },
                ...(isDarkMode ? darkInactive : lightInactive),
              }}
              disabled={selectedFiles.size === 0 || effectiveIsLoading}
            >
              <DeleteOutlineIcon />
              {t('file_browser.delete_count_file', { count: selectedFiles.size })}
            </Button>
          )}
          {tabIndex === 0 && (
            <Button
              onClick={onUnselectAll}
              color="neutral"
              variant="solid"
              sx={{
                fontWeight: '500',
                width: '180px',
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                border: '1px solid',
                borderColor: theme.palette.background.level2,
                backgroundColor: theme => theme.palette.background.level1,
                '&:hover': {
                  backgroundColor: theme => theme.palette.background.level2,
                  borderColor: theme => theme.palette.divider,
                },
              }}
            >
              {selectedFiles.size > 0 ? <ClearIcon /> : null}
              {selectedFiles.size > 0
                ? t('projects.modals.generic.unselect_all')
                : t('projects.modals.generic.select_all')}
            </Button>
          )}
          {canUpdateOrNewSession && (
            <Button
              onClick={handleBulkAdd}
              color="primary"
              variant="solid"
              data-testid="file-browser-bulk-add-btn"
              sx={theme => ({
                fontWeight: '500',
                width: '180px',
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                ...(isDarkMode ? darkInactive : lightInactive),
              })}
              disabled={selectedFiles.size === 0 || effectiveIsLoading}
            >
              <AddIcon />
              {t('file_browser.add_count_file', { count: selectedFiles.size })}
            </Button>
          )}
        </Box>
      </Box>
      {!!fileToShare && (
        <ShareDocumentModal
          onClose={() => setFileToShare(null)}
          open={true}
          id={fileToShare.id}
          name={fileToShare.fileName}
          type={InviteType.FabFile}
          users={fileToShare.users}
        />
      )}
      {publishShareModal}
    </>
  );
};

export default FileList;

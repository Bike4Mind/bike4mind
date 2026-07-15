import { IFabFileDocument } from '@bike4mind/common';
import {
  useCloneFabFile,
  useDeleteFile,
  useUpdateFabFile,
  useGetPresignedUrl,
  useAutoRenameFabFile,
  useApplyAutoRenameFabFile,
} from '@client/app/hooks/data/fabFiles';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useGetFileTags, useToggleTagToFiles } from '@client/app/hooks/data/tag';
import CloseIcon from '@mui/icons-material/Close';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import NoteIcon from '@mui/icons-material/Note';
import SegmentIcon from '@mui/icons-material/Segment';
import Search from '@mui/icons-material/Search';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import {
  Box,
  Button,
  CircularProgress,
  Dropdown,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuButtonProps,
  MenuItem,
  Modal,
  ModalDialog,
  Stack,
  Switch,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import IosShareIcon from '@mui/icons-material/IosShare';
import CheckIcon from '@mui/icons-material/Check';
import AutoRenewIcon from '@mui/icons-material/Autorenew';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { FC, useState, type MouseEvent, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import KnowledgeChunkControls from '../../Knowledge/KnowledgeChunkControls';
import { useKnowledgeModal } from '../../Knowledge/KnowledgeModal';
import { useShallow } from 'zustand/react/shallow';
import { ProjectAddToModal } from '../../Project/ProjectAddToModal';
import { useFileBrowserInstance } from './instanceContext';
import { useUser } from '@client/app/contexts/UserContext';

const FileBrowserItemActions: FC<{
  file: IFabFileDocument;
  size?: MenuButtonProps['size'];
  onRename: () => void;
}> = ({ file, onRename, size = 'sm' }) => {
  const { t } = useTranslation();
  const update = useUpdateFabFile();
  const [setFileId, setOpenKnowledgeModal, setViewOnly] = useKnowledgeModal(
    useShallow(s => [s.setSelectedFabFileId, s.setOpen, s.setViewOnly])
  );
  const clone = useCloneFabFile();
  const deleteFile = useDeleteFile();
  const confirm = useConfirmation();
  const { mutateAsync: getPresignedUrl } = useGetPresignedUrl();
  const { setFileToShare, config } = useFileBrowserInstance();
  const autoRename = useAutoRenameFabFile();
  const applyAutoRename = useApplyAutoRenameFabFile();
  const { currentUser } = useUser();
  const isSharedToMe = currentUser != null && file.userId !== currentUser.id;
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [openProjectModal, setOpenProjectModal] = useState(false);
  const [showChunkModal, setShowChunkModal] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showTagsModal, setShowTagsModal] = useState(false);
  const [showAutoRenameModal, setShowAutoRenameModal] = useState(false);
  const [renameSuggestion, setRenameSuggestion] = useState<{
    currentName: string;
    suggestedName: string;
  } | null>(null);

  // Helper to force direct download instead of opening the file in a new tab
  const handleDirectDownload = async (): Promise<void> => {
    try {
      const path = file.filePath;

      if (path) {
        const urls = await getPresignedUrl({ filePaths: [path], expiresIn: 3600 });
        const signedUrl = urls?.[0];
        if (!signedUrl) throw new Error('No signed URL returned');

        // Fetch the file as a Blob and download it via Object URL (forces download)
        const response = await fetch(signedUrl);
        if (!response.ok) throw new Error('Failed to fetch file');
        const blob = await response.blob();
        const objectUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.setAttribute('download', file.fileName || 'download');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Revoke the object URL shortly after to free memory
        setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
      } else {
        // Fallback to legacy server route if no path is available
        const response = await fetch(`/api/files/download?id=${file.id}`);
        if (!response.ok) throw new Error('Failed to fetch file');
        const blob = await response.blob();
        const objectUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.setAttribute('download', file.fileName || 'download');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
      }
    } catch (error) {
      console.error('Download failed:', error);
      toast.error('Failed to download file');
    }
  };

  return (
    <>
      <Dropdown>
        <MenuButton
          className="file-browser-actions-menu-btn"
          data-testid="file-browser-actions-menu-btn"
          onClick={(e: MouseEvent) => e.stopPropagation()}
          slots={{ root: IconButton }}
          slotProps={{
            root: {
              variant: 'plain',
              color: 'text.primary',
              slotProps: { size },
              sx: {
                opacity: 0.6,
                color: 'text.primary',
                transition: 'opacity 0.2s',
                '&:hover': {
                  opacity: 1,
                },
              },
            },
          }}
        >
          <MoreVertIcon />
        </MenuButton>
        <Menu
          className="file-browser-actions-menu"
          placement="auto"
          sx={{
            zIndex: 99999,
            width: '200px',
            '&[data-popper-placement^="top"]': {
              transformOrigin: 'bottom center',
            },
            '&[data-popper-placement^="bottom"]': {
              transformOrigin: 'top center',
            },
          }}
          onClick={(e: MouseEvent) => e.stopPropagation()}
        >
          <MenuItem
            className="file-browser-actions-menu-item-view"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              setFileId(file.id);
              setViewOnly(false);
              setOpenKnowledgeModal(true);
            }}
            sx={{ py: 1, mb: 0.125 }}
          >
            <VisibilityOutlinedIcon /> View
          </MenuItem>
          {!isSharedToMe && (
            <MenuItem
              data-testid="file-browser-rename-item"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onRename();
              }}
              sx={{ py: 1, mb: 0.125 }}
            >
              <EditOutlinedIcon /> Rename
            </MenuItem>
          )}
          {!isSharedToMe && (
            <MenuItem
              onClick={async (e: MouseEvent) => {
                e.stopPropagation();
                try {
                  const result = await autoRename.mutateAsync(file.id);
                  setRenameSuggestion({
                    currentName: result.currentName,
                    suggestedName: result.suggestedName,
                  });
                  setShowAutoRenameModal(true);
                } catch (error) {
                  // Error toast is handled by the hook
                }
              }}
              disabled={autoRename.isPending}
              sx={{ py: 1, mb: 0.125 }}
            >
              {autoRename.isPending ? <CircularProgress size="sm" /> : <AutoRenewIcon />}
              Rename Automatically
            </MenuItem>
          )}
          {!isSharedToMe && (
            <MenuItem
              onClick={async (e: MouseEvent) => {
                e.stopPropagation();
                clone.mutate(file);
              }}
              disabled={clone.isPending}
              sx={{ py: 1, mb: 0.125 }}
            >
              {clone.isPending ? <CircularProgress size="sm" /> : <ContentCopyIcon />}
              Clone
            </MenuItem>
          )}

          <MenuItem
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              await handleDirectDownload();
            }}
            sx={{ py: 1, mb: 0.125 }}
          >
            <SaveAltIcon />
            {t('file_actions.download')}
          </MenuItem>

          <MenuItem
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              setFileToShare(file);
            }}
            sx={{ py: 1, mb: 0.125 }}
          >
            <IosShareIcon />
            Share
          </MenuItem>
          {!isSharedToMe && (
            <MenuItem
              onClick={async (e: MouseEvent) => {
                e.stopPropagation();
                setPropertiesOpen(true);
              }}
              sx={{ py: 1, mb: 0.125 }}
            >
              <SettingsOutlinedIcon />
              Instructions
            </MenuItem>
          )}
          <MenuItem
            onClick={async (e: MouseEvent) => {
              e.stopPropagation();
              setOpenProjectModal(true);
            }}
            sx={{ py: 1, mb: 0.125 }}
          >
            <CreateNewFolderOutlinedIcon />
            Add to project
          </MenuItem>
          {!isSharedToMe && !file.error && (
            <MenuItem onClick={() => setShowChunkModal(true)} sx={{ py: 1, mb: 0.125 }}>
              <SegmentIcon sx={{ fontSize: '18px' }} />
              Vectorize
            </MenuItem>
          )}
          {!isSharedToMe && file.error && (
            <MenuItem onClick={() => setShowChunkModal(true)} sx={{ py: 1, mb: 0.125 }}>
              <SegmentIcon sx={{ fontSize: '18px' }} />
              Retry Vectorize
            </MenuItem>
          )}
          {!isSharedToMe && (
            <MenuItem onClick={() => setShowTagsModal(true)} sx={{ py: 1, mb: 0.125 }}>
              <LocalOfferIcon sx={{ fontSize: '18px' }} />
              Manage Tags
            </MenuItem>
          )}
          {!isSharedToMe && file.primaryTag && (
            <MenuItem
              onClick={async (e: MouseEvent) => {
                e.stopPropagation();
                try {
                  await update.mutateAsync({
                    id: file.id,
                    fileName: file.fileName,
                    mimeType: file.mimeType,
                    type: file.type,
                    primaryTag: null,
                  });
                } catch (err) {
                  // noop, toast handled by global hooks
                }
              }}
              sx={{ py: 1, mb: 0.125 }}
            >
              <LocalOfferIcon sx={{ fontSize: '18px' }} />
              Clear Primary Tag
            </MenuItem>
          )}
          <MenuItem onClick={() => setShowNoteModal(true)} sx={{ py: 1, mb: 0.125 }}>
            <NoteIcon />
            {file.notes ? t('file_actions.edit_notes') : t('file_actions.add_note')}
          </MenuItem>
          <MenuItem
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              // Embedded pickers override delete to remove-from-list (for owned AND shared
              // files) so the picker never destroys a file or drops a share; matches the
              // bulk delete path in Content.
              if (config.onDelete) {
                const onDelete = config.onDelete;
                confirm({
                  title: `Remove ${file.fileName || 'file'}`,
                  description: 'Remove this file from the list? The file itself is not deleted.',
                  type: 'warning',
                  okLabel: 'Remove',
                  onOk: async () => {
                    onDelete([file.id]);
                  },
                });
              } else if (isSharedToMe) {
                confirm({
                  title: `Remove ${file.fileName || 'file'}`,
                  description:
                    "You will be removed from the share list for this file. It will no longer appear in your browser. The owner's copy is not affected.",
                  type: 'warning',
                  okLabel: 'Remove',
                  onOk: async () => {
                    deleteFile.mutate(file.id);
                  },
                });
              } else {
                confirm({
                  title: `Delete ${file.fileName || 'file'}`,
                  description: 'Are you sure you want to delete this file?',
                  type: 'danger',
                  okLabel: 'Delete',
                  onOk: async () => {
                    deleteFile.mutate(file.id);
                  },
                });
              }
            }}
            disabled={deleteFile.isPending}
            color={config.onDelete || isSharedToMe ? 'warning' : 'danger'}
            sx={{ py: 1, mb: 0.125 }}
          >
            {deleteFile.isPending ? (
              <CircularProgress size="sm" />
            ) : config.onDelete || isSharedToMe ? (
              <LinkOffIcon />
            ) : (
              <DeleteOutline />
            )}
            {config.onDelete ? 'Remove from list' : isSharedToMe ? 'Remove from my files' : 'Delete'}
          </MenuItem>
        </Menu>
      </Dropdown>
      {propertiesOpen && (
        <FilePropertiesModal
          file={file}
          open={propertiesOpen}
          onClose={() => {
            setPropertiesOpen(false);
          }}
        />
      )}
      {openProjectModal && (
        <div
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
          }}
        >
          <ProjectAddToModal
            dataId={file.id || ''}
            dataType="file"
            open={!!openProjectModal}
            setOpen={open => setOpenProjectModal(open)}
          />
        </div>
      )}
      {showChunkModal && <FileChunkModal file={file} open={showChunkModal} onClose={() => setShowChunkModal(false)} />}
      {showTagsModal && <FileTagsModal file={file} open={showTagsModal} onClose={() => setShowTagsModal(false)} />}
      {showNoteModal && <FileNotesModal open={showNoteModal} onClose={() => setShowNoteModal(false)} file={file} />}
      {showAutoRenameModal && renameSuggestion && (
        <FileAutoRenameModal
          currentName={renameSuggestion.currentName}
          suggestedName={renameSuggestion.suggestedName}
          open={showAutoRenameModal}
          onClose={() => {
            setShowAutoRenameModal(false);
            setRenameSuggestion(null);
          }}
          onConfirm={async (newFileName: string) => {
            await applyAutoRename.mutateAsync({ fileId: file.id, newFileName });
            setShowAutoRenameModal(false);
            setRenameSuggestion(null);
          }}
        />
      )}
    </>
  );
};

const FileTagsModal: FC<{ file: IFabFileDocument; open: boolean; onClose: () => void }> = ({ file, open, onClose }) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const { data: allTags } = useGetFileTags();
  const { mutateAsync: toggleTagToFiles } = useToggleTagToFiles();
  const update = useUpdateFabFile();

  // Get current file tags
  const fileTags = allTags?.filter(tag => file.tags?.some(t => t.name.toLowerCase() === tag.name.toLowerCase())) || [];

  // Get available tags (not on this file)
  const availableTags =
    allTags?.filter(tag => !file.tags?.some(t => t.name.toLowerCase() === tag.name.toLowerCase())) || [];

  // Filter tags based on search
  const filteredFileTags = fileTags.filter(tag => tag.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const filteredAvailableTags = availableTags.filter(tag => tag.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const toggleTagSelection = (tagId: string) => {
    setSelectedTagIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(tagId)) {
        newSet.delete(tagId);
      } else {
        newSet.add(tagId);
      }
      return newSet;
    });
  };

  const handleRemoveTag = async (tag: any) => {
    await toggleTagToFiles({
      ids: [file.id],
      tags: [tag],
    });
  };

  const handleAddSelectedTags = async () => {
    const tagsToAdd = availableTags.filter(tag => selectedTagIds.has(tag.id));
    if (tagsToAdd.length === 0) return;

    await toggleTagToFiles({
      ids: [file.id],
      tags: tagsToAdd,
    });

    setSelectedTagIds(new Set());
  };

  const handleSetPrimary = async (tagName: string) => {
    const isPrimary = file.primaryTag === tagName;
    await update.mutateAsync({
      id: file.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      type: file.type,
      primaryTag: isPrimary ? null : tagName,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="file-tags-modal"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ModalDialog variant="plain" sx={{ minWidth: 700, maxWidth: '90vw', maxHeight: '85vh' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <LocalOfferIcon sx={{ fontSize: 20 }} />
            <Typography level="title-lg">{t('file_actions.manage_tags')}</Typography>
          </Stack>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>

        {/* File name */}
        <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
          File: <strong>{file.fileName}</strong>
        </Typography>

        {/* Search */}
        <Input
          size="sm"
          placeholder="Search tags..."
          value={searchQuery}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          startDecorator={<Search sx={{ fontSize: 16 }} />}
          endDecorator={
            searchQuery && (
              <IconButton size="sm" variant="plain" onClick={() => setSearchQuery('')}>
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            )
          }
          sx={{ mb: 2 }}
        />

        {/* Two Column Layout */}
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, flex: 1, minHeight: 0 }}>
          {/* Left Column: Tags on This File */}
          <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography level="body-sm" sx={{ mb: 1.5, fontWeight: 600, color: 'text.primary' }}>
              Tags on this file ({fileTags.length})
            </Typography>
            <Box sx={{ flex: 1, overflowY: 'auto', pr: 1 }}>
              <Stack gap={1}>
                {filteredFileTags.length === 0 ? (
                  <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                    {searchQuery ? 'No matching tags' : 'No tags on this file'}
                  </Typography>
                ) : (
                  filteredFileTags.map(tag => {
                    const isPrimary = file.primaryTag === tag.name;
                    return (
                      <Box
                        key={tag.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          p: 1.5,
                          borderRadius: '8px',
                          border: '1px solid',
                          borderColor: isPrimary ? tag.color : 'border.solid',
                          backgroundColor: isPrimary ? `${tag.color}10` : 'background.level1',
                          transition: 'all 0.2s',
                          '&:hover': {
                            backgroundColor: 'background.level2',
                          },
                        }}
                      >
                        <Stack direction="row" alignItems="center" gap={1.5} sx={{ flex: 1, minWidth: 0 }}>
                          <Box
                            sx={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '6px',
                              backgroundColor: tag.color,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '14px',
                              flexShrink: 0,
                            }}
                          >
                            {tag.icon || '🏷️'}
                          </Box>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography
                              level="body-sm"
                              sx={{
                                fontWeight: isPrimary ? 600 : 500,
                                color: 'text.primary',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {isPrimary && '★ '}
                              {tag.name}
                            </Typography>
                          </Box>
                        </Stack>
                        <Stack direction="row" gap={0.5}>
                          <Tooltip title={isPrimary ? 'Unset as primary' : 'Set as primary'}>
                            <IconButton
                              size="sm"
                              variant="plain"
                              onClick={() => handleSetPrimary(tag.name)}
                              sx={{ minWidth: '28px', minHeight: '28px' }}
                            >
                              <StarOutlineIcon sx={{ fontSize: 16, color: isPrimary ? tag.color : 'text.tertiary' }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Remove tag">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="danger"
                              onClick={() => handleRemoveTag(tag)}
                              sx={{ minWidth: '28px', minHeight: '28px' }}
                            >
                              <CloseIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </Box>
                    );
                  })
                )}
              </Stack>
            </Box>
          </Box>

          {/* Right Column: Available Tags */}
          <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
              <Typography level="body-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
                Available tags ({availableTags.length})
              </Typography>
              {selectedTagIds.size > 0 && (
                <Button
                  size="sm"
                  variant="solid"
                  onClick={handleAddSelectedTags}
                  sx={{ fontSize: '12px', py: 0.5, px: 1.5 }}
                >
                  Add {selectedTagIds.size} tag{selectedTagIds.size !== 1 ? 's' : ''}
                </Button>
              )}
            </Stack>
            <Box sx={{ flex: 1, overflowY: 'auto', pr: 1 }}>
              <Stack gap={1}>
                {filteredAvailableTags.length === 0 ? (
                  <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                    {searchQuery ? 'No matching tags' : 'All tags are on this file'}
                  </Typography>
                ) : (
                  filteredAvailableTags.map(tag => {
                    const isSelected = selectedTagIds.has(tag.id);
                    return (
                      <Box
                        key={tag.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          p: 1.5,
                          borderRadius: '8px',
                          border: '1px solid',
                          borderColor: isSelected ? tag.color : 'border.solid',
                          backgroundColor: isSelected ? `${tag.color}15` : 'background.level1',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          '&:hover': {
                            backgroundColor: isSelected ? `${tag.color}20` : 'background.level2',
                            borderColor: tag.color,
                          },
                        }}
                        onClick={() => toggleTagSelection(tag.id)}
                      >
                        <Stack direction="row" alignItems="center" gap={1.5} sx={{ flex: 1, minWidth: 0 }}>
                          {/* Checkbox */}
                          <Box
                            sx={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '4px',
                              border: '1px solid',
                              borderColor: isSelected ? tag.color : 'border.solid',
                              backgroundColor: isSelected ? tag.color : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              transition: 'all 0.2s',
                            }}
                          >
                            {isSelected && <CheckIcon sx={{ fontSize: 14, color: 'white' }} />}
                          </Box>

                          <Box
                            sx={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '6px',
                              backgroundColor: tag.color,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '14px',
                              flexShrink: 0,
                            }}
                          >
                            {tag.icon || '🏷️'}
                          </Box>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography
                              level="body-sm"
                              sx={{
                                fontWeight: isSelected ? 600 : 500,
                                color: 'text.primary',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {tag.name}
                            </Typography>
                            <Typography level="body-xs" sx={{ color: 'text.tertiary', fontSize: '11px' }}>
                              {tag.fileCount} file{tag.fileCount !== 1 ? 's' : ''}
                            </Typography>
                          </Box>
                        </Stack>
                      </Box>
                    );
                  })
                )}
              </Stack>
            </Box>
          </Box>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

const FileChunkModal: FC<{ file: IFabFileDocument; open: boolean; onClose: () => void }> = ({
  file,
  open,
  onClose,
}) => {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="file-chunk-modal"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ModalDialog variant="plain" sx={{ minWidth: 520 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography level="title-lg">{t('file_actions.vectorize')}</Typography>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <KnowledgeChunkControls fabFile={file} />
      </ModalDialog>
    </Modal>
  );
};

const FilePropertiesModal: FC<{ file: IFabFileDocument; open: boolean; onClose: () => void }> = ({
  file,
  open,
  onClose,
}) => {
  const { t } = useTranslation();
  const update = useUpdateFabFile({
    onSuccess: () => onClose(),
  });

  const [system, setSystem] = useState<boolean>(!!file.system);
  const [systemPriority, setSystemPriority] = useState<number>(file.systemPriority ?? 999);
  const [notes, setNotes] = useState<string>(file.notes || '');

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="file-properties-modal"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ModalDialog variant="plain" sx={{ minWidth: 520 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography level="title-lg">{t('file_properties.title')}</Typography>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Box>
          <FormControl sx={{ my: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <FormLabel>{t('file_properties.make_instructions')}</FormLabel>
              <Switch checked={system} onChange={(e: ChangeEvent<HTMLInputElement>) => setSystem(e.target.checked)} />
            </Stack>
          </FormControl>
          <FormControl sx={{ my: 1 }}>
            <FormLabel>{t('file_properties.instruction_priority')}</FormLabel>
            <Input
              type="number"
              disabled={!system}
              value={systemPriority}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const val = parseInt(e.target.value, 10);
                setSystemPriority(Number.isNaN(val) ? 0 : val);
              }}
              slotProps={{
                input: {
                  min: 0,
                  max: 999,
                },
              }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'neutral.500' }}>
              {t('file_properties.priority_levels.global')}
              <br />
              {t('file_properties.priority_levels.group')}
              <br />
              {t('file_properties.priority_levels.project')}
              <br />
              {t('file_properties.priority_levels.user')}
            </Typography>
          </FormControl>
          <FormControl sx={{ my: 1 }}>
            <FormLabel>{t('file_actions.notes')}</FormLabel>
            <Textarea
              value={notes}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              minRows={2}
              placeholder={t('file_actions.notes_placeholder') as string}
            />
          </FormControl>
        </Box>
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button variant="plain" color="neutral" onClick={onClose} disabled={update.isPending}>
            {t('file_actions.cancel')}
          </Button>
          <Button
            variant="solid"
            color="primary"
            loading={update.isPending}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
              update.mutate({
                id: file.id,
                system,
                systemPriority,
                notes,
              });
            }}
          >
            {t('file_actions.save')}
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

const FileNotesModal: FC<{ open: boolean; onClose: () => void; file: IFabFileDocument }> = ({
  open,
  onClose,
  file,
}) => {
  const { t } = useTranslation();
  const update = useUpdateFabFile({ onSuccess: onClose });
  const [notes, setNotes] = useState<string>(file?.notes || '');

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="file-notes-modal"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ModalDialog variant="plain" sx={{ minWidth: 420 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography level="title-lg">
            {file.notes ? t('file_actions.edit_notes') : t('file_actions.add_note')}
          </Typography>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Textarea
          value={notes}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
          minRows={4}
          placeholder={t('file_actions.notes_placeholder') as string}
        />
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={update.isPending}>
            {t('file_actions.cancel')}
          </Button>
          <Button
            variant="solid"
            color="primary"
            loading={update.isPending}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
              update.mutate({ id: file.id, notes });
            }}
          >
            {t('file_actions.save')}
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

const FileAutoRenameModal: FC<{
  currentName: string;
  suggestedName: string;
  open: boolean;
  onClose: () => void;
  onConfirm: (newFileName: string) => Promise<void>;
}> = ({ currentName, suggestedName, open, onClose, onConfirm }) => {
  const [editedName, setEditedName] = useState(suggestedName);
  const [isApplying, setIsApplying] = useState(false);

  const handleConfirm = async () => {
    setIsApplying(true);
    try {
      await onConfirm(editedName);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-labelledby="auto-rename-modal"
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ModalDialog variant="plain" sx={{ minWidth: 480, maxWidth: 600 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <AutoRenewIcon sx={{ fontSize: 20 }} />
            <Typography level="title-lg">Rename File</Typography>
          </Stack>
          <IconButton onClick={onClose} disabled={isApplying}>
            <CloseIcon />
          </IconButton>
        </Stack>

        <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
          AI has generated a suggested filename based on the file content. You can edit it before applying.
        </Typography>

        <Stack spacing={2}>
          <Box>
            <Typography level="body-sm" sx={{ mb: 0.5, fontWeight: 600, color: 'text.primary' }}>
              Current name:
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
              {currentName}
            </Typography>
          </Box>

          <Box>
            <Typography level="body-sm" sx={{ mb: 0.5, fontWeight: 600, color: 'text.primary' }}>
              Suggested name:
            </Typography>
            <Input
              value={editedName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditedName(e.target.value)}
              disabled={isApplying}
              sx={{ fontFamily: 'monospace' }}
              autoFocus
            />
          </Box>
        </Stack>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 3 }}>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={isApplying}>
            Cancel
          </Button>
          <Button
            variant="solid"
            color="primary"
            onClick={handleConfirm}
            disabled={isApplying || !editedName.trim()}
            loading={isApplying}
          >
            Apply Rename
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default FileBrowserItemActions;

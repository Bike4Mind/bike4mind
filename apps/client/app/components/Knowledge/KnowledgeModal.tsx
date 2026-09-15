import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useUser } from '@client/app/contexts/UserContext';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import {
  updateFileUtility,
  createFabFileOnServerWithUpload,
  getFabFileByIdFromServer,
} from '@client/app/utils/filesAPICalls';
import { IFabFileDocument, IFabFileListItemDocument, ISystemFileEntry, KnowledgeType } from '@bike4mind/common';
import HistoryIcon from '@mui/icons-material/History';
import SaveIcon from '@mui/icons-material/Save';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  FormLabel,
  Input,
  LinearProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Select,
  Option,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import dynamic from 'next/dynamic';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { userCanUpdateDoc } from '@client/app/utils/userPermission';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useQueryClient } from '@tanstack/react-query';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';
import { useParams } from '@tanstack/react-router';
import rehypeSanitize from 'rehype-sanitize';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { whiteAlpha } from '@client/app/utils/themes/colors';
import { COMMON_FILE_FORMATS, getFormatByMimeType, updateFileNameExtension } from '@client/app/utils/fileFormatUtils';
import CodeIcon from '@mui/icons-material/Code';
import { ContextHelpButton } from '@client/app/components/help';

// Dynamic imports to avoid SSR issues
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });
const PdfViewer = dynamic(() => import('@client/app/components/PdfViewer'), { ssr: false });

interface SystemFile extends ISystemFileEntry {
  systemPriority?: number;
}

export const DeleteFabFileModal = ({
  onClose,
  fabFileToDelete,
  onDeleteFabFile,
}: {
  fabFileToDelete: IFabFileListItemDocument | null;
  onDeleteFabFile: (id: string | undefined) => Promise<void>;
  onClose: () => void;
}) => {
  const [loading, setLoading] = useState<boolean>(false);
  const title = 'Delete Fab File?';
  const description = `This will delete ${fabFileToDelete?.fileName}`;

  const onGoForward = async () => {
    setLoading(true);
    try {
      await onDeleteFabFile(fabFileToDelete?.id);
      setLoading(false);
      onClose();
    } catch (e) {
      setLoading(false);
    }
  };

  return (
    <ConfirmActionModal
      title={title}
      description={description}
      onGoBackward={onClose}
      onGoForward={onGoForward}
      itemId={fabFileToDelete?.id}
      forwardButtonText="Delete"
      backwardButtonText="Cancel"
      loading={loading}
    />
  );
};
export const useKnowledgeModal = create<{
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  selectedFabFileId: string | null;
  setSelectedFabFileId: (id: string | null) => void;
  viewOnly: boolean;
  setViewOnly: (viewOnly: boolean) => void;
}>(set => ({
  open: false,
  selectedFabFileId: null,
  viewOnly: false,
  setOpen: open => set(state => ({ open: typeof open === 'function' ? open(state.open) : open })),
  setSelectedFabFileId: id => set({ selectedFabFileId: id }),
  setViewOnly: viewOnly => set({ viewOnly }),
}));

interface IFabFileFormData extends Omit<IFabFileDocument, 'id'> {
  id?: string;
}

const KnowledgeModal: React.FC = () => {
  const { id: projectId } = useParams({ strict: false });
  const { open, setOpen, selectedFabFileId, viewOnly } = useKnowledgeModal();

  const [fabFile, setFabFile] = useState<IFabFileFormData | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [editedContent, setEditedContent] = useState<string>('');
  const [savingEditedContent, setSavingEditedContent] = useState<boolean>(false);
  const [editedFileName, setEditedFileName] = useState<string>(fabFile?.fileName || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();
  const { setFilesMetaDataVersion, currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();

  const { currentUser } = useUser();

  const [systemEnabled, setSystemEnabled] = useState(false);
  const [systemPriority, setSystemPriority] = useState(999);
  const [selectedMimeType, setSelectedMimeType] = useState<string>('');

  // Update system settings and mime type when file loads
  useEffect(() => {
    if (fabFile) {
      setSystemEnabled(!!fabFile.system);
      setSystemPriority(fabFile.systemPriority ?? 999);
      setSelectedMimeType(fabFile.mimeType || 'text/plain');
    } else {
      // Default values for new files
      setSystemEnabled(true);
      setSystemPriority(999);
      setSelectedMimeType('text/plain');
    }
  }, [fabFile]);

  // Update filename extension when mime type changes
  useEffect(() => {
    if (selectedMimeType && editedFileName) {
      const newFileName = updateFileNameExtension(editedFileName, selectedMimeType);
      if (newFileName !== editedFileName) {
        setEditedFileName(newFileName);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMimeType]);

  const fetchFabFile = useCallback(async (fabFileId: string) => {
    const abortController = new AbortController();

    try {
      // Reset the fabFile if the selectedFabFileId is different from the previous one
      setFabFile(prev => (prev?.id === fabFileId ? prev : null));
      setLoading(true);

      // Always fetch from the API to refresh signed url
      const fullFabFile = await getFabFileByIdFromServer(fabFileId);

      if (fullFabFile) {
        const content = await getContentFromFabfile({
          fileUrl: fullFabFile.fileUrl,
          mimeType: fullFabFile.mimeType,
        });

        setFabFile(fullFabFile);
        setFileContent(content);
        setEditedContent(content);
        setEditedFileName(fullFabFile.fileName);
      } else {
        console.error('FabFile not found:', fabFileId);
        toast.error('File not found');
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('Error fetching FabFile:', error);
        toast.error('Failed to load file');
      }
    } finally {
      if (!abortController.signal.aborted) {
        setLoading(false);
      }
    }

    return () => {
      abortController.abort();
    };
  }, []);

  // Load fabfile form data
  useEffect(() => {
    if (!open) return;
    if (!currentUser?.id) return;

    setFileContent('');
    setEditedContent('');
    if (!selectedFabFileId) {
      const content = '';
      const fileName = 'Noodle.md';
      const mimeType = 'text/markdown';
      const file = new File([content], fileName, { type: mimeType });

      const newFabFile: IFabFileFormData = {
        type: KnowledgeType.TEXT,
        fileName,
        mimeType,
        fileSize: file.size,
        userId: currentUser.id,
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        groups: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setFabFile(newFabFile);
      setEditedContent(content);
      setFileContent(content);
      setEditedFileName(newFabFile.fileName);
    } else {
      fetchFabFile(selectedFabFileId);
    }
  }, [selectedFabFileId, fetchFabFile, open, currentUser?.id]);

  useEffect(() => {
    const unsubscribe = subscribeToAction('update_file_chunk_vector_status', async msg => {
      if (msg.action !== 'update_file_chunk_vector_status' || msg.fabFileId !== fabFile?.id) return;

      setFabFile(prevFabFile => {
        if (!prevFabFile) return prevFabFile;

        return {
          ...prevFabFile,
          ...(msg.chunkStatus
            ? {
                isChunking: msg.chunkStatus === 'ongoing',
                chunked: msg.chunkStatus === 'complete',
              }
            : {}),
          ...(msg.vectorizeStatus
            ? {
                isVectorizing: msg.vectorizeStatus === 'ongoing',
                vectorized: msg.vectorizeStatus === 'complete',
              }
            : {}),
        };
      });
    });
    return unsubscribe;
  }, [subscribeToAction, fabFile?.id]);

  const onUpdate = async (id: string, updatedFabFile: Partial<IFabFileDocument & { fileContent?: string }>) => {
    // Store previous data for rollback
    const previousData = queryClient.getQueryData(['fabFile', id]) as IFabFileDocument | null;

    try {
      // Optimistically update local state
      setFabFile(prev => (prev ? { ...prev, ...updatedFabFile } : null));
      setWorkBenchFiles(currentSessionId ?? '', (files: IFabFileDocument[]) =>
        files.map(f => (f.id === id ? { ...f, ...updatedFabFile } : f))
      );

      // Perform the actual update
      const file = await updateFileUtility(id, updatedFabFile);
      if (!file) return null;

      queryClient.invalidateQueries({ queryKey: ['fabFile', id] });
      setFilesMetaDataVersion(prevVersion => prevVersion + 1);

      return file;
    } catch (error: unknown) {
      // Rollback on error
      setFabFile(previousData);
      setWorkBenchFiles(currentSessionId ?? '', (files: IFabFileDocument[]) =>
        files.map(f => (f.id === id ? previousData || f : f))
      );
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Unknown error occurred');
    }
  };

  const handleSave = async () => {
    if (!fabFile) return;

    setSavingEditedContent(true);
    try {
      const fileName = editedFileName;
      const mimeType = selectedMimeType || fabFile?.mimeType || 'text/plain';

      const fileData = {
        ...fabFile,
        fileContent: editedContent,
        fileName: fileName,
        mimeType: mimeType,
        // Only include system properties if enabled
        ...(systemEnabled
          ? {
              system: true,
              systemPriority: systemPriority,
            }
          : {
              system: false,
              systemPriority: undefined,
            }),
      };

      if (fabFile?.id) {
        const updated = await onUpdate(fabFile.id, fileData);
        if (updated) {
          setFabFile(updated);
          setWorkBenchFiles(currentSessionId ?? '', (files: IFabFileDocument[]) =>
            files.map(f => (f.id === updated.id ? updated : f))
          );
        }
      } else {
        const newFabFile = await createFabFileOnServerWithUpload(fileData, new File([editedContent], 'temp'));
        setFabFile(newFabFile as IFabFileDocument);
        setWorkBenchFiles(currentSessionId ?? '', files => [...files, newFabFile as IFabFileDocument]);

        // If system is enabled for new file, add it to user's systemFiles
        if (systemEnabled && currentUser && newFabFile) {
          const currentSystemFiles = currentUser.systemFiles || [];
          const maxPriority = Math.max(0, ...currentSystemFiles.map(f => (f as SystemFile).systemPriority || 0));
          const updatedSystemFiles = [
            ...currentSystemFiles,
            {
              fileId: newFabFile.id,
              enabled: true,
              systemPriority: systemPriority || maxPriority + 1,
            } as SystemFile,
          ];

          try {
            const updatedUser = await updateUserToServer(currentUser.id, { systemFiles: updatedSystemFiles });
            // Force update the user cache with the new data
            queryClient.setQueryData(['user', currentUser.id], updatedUser);
            // Also invalidate to ensure all components refresh
            queryClient.invalidateQueries({ queryKey: ['user'] });
            queryClient.invalidateQueries({ queryKey: ['system-prompt-files'] });
            queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
          } catch (error) {
            console.error('Failed to add system file to user profile:', error);
            toast.error('File saved but failed to add to system prompts');
          }
        }
      }
      if (systemEnabled && !fabFile?.id) {
        toast.success('System prompt file created and added to your current list!');
      } else {
        toast.success('File saved successfully');
      }
      setFilesMetaDataVersion(prevVersion => prevVersion + 1);
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });

      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      }

      setFileContent(editedContent);
    } catch {
      toast.error('Failed to save file content');
    } finally {
      setSavingEditedContent(false);
    }
  };

  const onRevert = async () => {
    setEditedContent(fileContent);
  };

  useEffect(() => {
    if (open && !loading) {
      inputRef.current?.focus();
    }
  }, [loading, open]);

  const contentDirty = useMemo(() => editedContent !== fileContent, [editedContent, fileContent]);
  const titleDirty = useMemo(() => editedFileName !== fabFile?.fileName, [editedFileName, fabFile?.fileName]);
  const systemDirty = useMemo(
    () => systemEnabled !== !!fabFile?.system || systemPriority !== (fabFile?.systemPriority ?? 999),
    [systemEnabled, systemPriority, fabFile?.system, fabFile?.systemPriority]
  );

  const isPdf = useMemo(() => fabFile?.mimeType === 'application/pdf', [fabFile?.mimeType]);
  const isDirty = contentDirty || titleDirty || systemDirty;

  const canUpdate = !viewOnly && (!!fabFile?.id || userCanUpdateDoc(currentUser, fabFile));
  return (
    <Modal
      className="knowledge-modal"
      open={open}
      onClose={() => setOpen(false)}
      sx={{
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ModalDialog
        className="knowledge-modal-dialog"
        data-testid="knowledge-modal"
        sx={{
          height: { xs: '100dvh', sm: '90vh' },
          maxHeight: { xs: '100dvh', sm: '90vh' },
          width: { xs: '100vw', sm: '90vw' },
          maxWidth: { xs: '100vw', sm: '90vw' },
          overflowY: 'auto',
          border: 'none',
          borderRadius: { xs: 0, sm: 'var(--joy-radius-md)' },
        }}
      >
        <Box
          className="knowledge-modal-header"
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0, px: 0 }}
        >
          <Typography level="h4" sx={{ flexGrow: 1, mr: 2 }}>
            {fabFile?.fileName
              ? viewOnly
                ? `Viewing: ${fabFile.fileName}`
                : `Editing: ${fabFile.fileName}`
              : 'Create New Knowledge'}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <ContextHelpButton
              helpId="features/knowledge-management"
              tooltipText="Learn about Knowledge Management"
              size="sm"
            />
            <ModalClose variant="plain" sx={{ position: 'static' }} data-testid="knowledge-modal-close-btn" />
          </Stack>
        </Box>

        {loading && (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: whiteAlpha[0][70],
              zIndex: 1,
            }}
          >
            <LinearProgress size={'lg'} sx={{ marginX: '5px', width: '100%' }} />
          </Box>
        )}

        <Stack className="knowledge-modal-content" spacing={2} sx={{ p: { xs: 0, md: 3 } }}>
          <Box
            className="knowledge-modal-content-wrapper"
            sx={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'background.level1',
              border: '1px solid',
              borderColor: 'border.solid',
              borderRadius: '5px',
              padding: '20px',
            }}
          >
            {/* View-only notice */}
            {viewOnly && fabFile?.id && (
              <Box
                className="knowledge-modal-view-only-notice"
                sx={{
                  mb: 2,
                  p: 2,
                  backgroundColor: 'neutral.softBg',
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'neutral.softColor',
                }}
              >
                <Typography level="body-sm" sx={{ color: 'neutral.plainColor' }}>
                  View-only mode
                </Typography>
              </Box>
            )}

            {/* Action Buttons */}
            {!isPdf && canUpdate && (
              <Stack
                className="knowledge-modal-action-buttons"
                direction="row"
                spacing={2}
                justifyContent="flex-end"
                sx={{
                  backgroundColor: 'background.level2',
                  borderRadius: 1,
                  p: 2,
                  mb: 2,
                }}
              >
                <Tooltip title="Revert Changes">
                  <Button disabled={!contentDirty} variant="plain" onClick={onRevert}>
                    <HistoryIcon />
                  </Button>
                </Tooltip>
                <Tooltip title="Save Changes">
                  <Button sx={{ marginLeft: '0!important' }} disabled={!isDirty} onClick={handleSave}>
                    {savingEditedContent ? <CircularProgress /> : <SaveIcon />}
                    <Box sx={{ marginLeft: '3px' }}>Save Changes</Box>
                  </Button>
                </Tooltip>
                <Divider sx={{ my: 2 }} />
              </Stack>
            )}

            {/* Title Input */}
            {!isPdf && canUpdate && (
              <Box sx={{ mb: 2 }}>
                <FormControl>
                  <FormLabel>File Name</FormLabel>
                  <Tooltip title={viewOnly ? 'File name (read-only)' : 'Enter the filename for this knowledge file'}>
                    <Input
                      value={viewOnly ? fabFile?.fileName || '' : editedFileName}
                      onChange={viewOnly ? undefined : e => setEditedFileName(e.target.value)}
                      placeholder={viewOnly ? '' : 'Enter filename...'}
                      readOnly={viewOnly}
                      sx={{
                        width: '100%',
                        backgroundColor: viewOnly ? 'background.level2' : undefined,
                      }}
                    />
                  </Tooltip>
                </FormControl>
              </Box>
            )}

            {/* Read-only file name display when not editable */}
            {!isPdf && !canUpdate && fabFile?.fileName && (
              <Box sx={{ mb: 2 }}>
                <FormControl>
                  <FormLabel>File Name</FormLabel>
                  <Input
                    value={fabFile.fileName}
                    readOnly
                    sx={{ width: '100%', backgroundColor: 'background.level2' }}
                  />
                </FormControl>
              </Box>
            )}

            {/* File Format Selector - Editable */}
            {!isPdf && canUpdate && (
              <Box sx={{ mb: 2 }}>
                <FormControl>
                  <FormLabel>File Format</FormLabel>
                  <Tooltip
                    title={
                      viewOnly ? 'File format (read-only)' : 'Choose the format for syntax highlighting and processing'
                    }
                  >
                    <Select
                      value={selectedMimeType}
                      onChange={(_, newValue) => {
                        if (newValue) setSelectedMimeType(newValue);
                      }}
                      disabled={viewOnly}
                      startDecorator={<CodeIcon />}
                      slotProps={{
                        listbox: {
                          sx: {
                            maxHeight: '300px',
                            overflow: 'auto',
                          },
                        },
                      }}
                      sx={{
                        width: '100%',
                        backgroundColor: viewOnly ? 'background.level2' : undefined,
                      }}
                    >
                      {COMMON_FILE_FORMATS.map(format => (
                        <Option key={format.mimeType} value={format.mimeType}>
                          <Box>
                            <Typography level="body-md">{format.label}</Typography>
                            {format.description && (
                              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                {format.description}
                              </Typography>
                            )}
                          </Box>
                        </Option>
                      ))}
                    </Select>
                  </Tooltip>
                </FormControl>
              </Box>
            )}

            {/* File Format Display - Read-only */}
            {!isPdf && !canUpdate && fabFile?.mimeType && (
              <Box sx={{ mb: 2 }}>
                <FormControl>
                  <FormLabel>File Format</FormLabel>
                  <Input
                    value={getFormatByMimeType(fabFile.mimeType)?.label || fabFile.mimeType}
                    readOnly
                    startDecorator={<CodeIcon />}
                    sx={{ width: '100%', backgroundColor: 'background.level2' }}
                  />
                </FormControl>
              </Box>
            )}

            {/* PDF Viewer */}
            {isPdf && fabFile?.fileUrl && (
              <Box sx={{ minHeight: '70vh', height: '100%', flexGrow: 1, overflow: 'auto' }}>
                <PdfViewer file={fabFile?.fileUrl} filename={fabFile?.fileName} />
              </Box>
            )}
            {/* Text Edit Area */}
            {!isPdf && !fabFile?.mimeType.startsWith('image/') && (
              <Box
                sx={{
                  width: '100%',
                  marginTop: '20px',
                  '& .w-md-editor': {
                    fontSize: '18px !important',
                  },
                  ...(viewOnly && {
                    '& .w-md-editor .w-md-editor-text': {
                      backgroundColor: 'background.level2 !important',
                    },
                    '& .w-md-editor .w-md-editor-text-textarea': {
                      backgroundColor: 'background.level2 !important',
                    },
                  }),
                }}
              >
                <MDEditor
                  value={viewOnly ? fileContent : editedContent}
                  onChange={viewOnly ? undefined : (value?: string) => setEditedContent(value || '')}
                  height={400}
                  data-color-mode="light"
                  preview={viewOnly ? 'preview' : 'edit'}
                  hideToolbar={viewOnly}
                  visibleDragbar={false}
                  textareaProps={{
                    placeholder: viewOnly ? '' : 'Start writing your knowledge content...',
                    readOnly: viewOnly,
                  }}
                  previewOptions={{
                    rehypePlugins: [[rehypeSanitize]],
                  }}
                />
              </Box>
            )}
            {fabFile?.mimeType.startsWith('image/') && (
              <Box
                sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' }}
              >
                <img src={fabFile.fileUrl} alt={fabFile.fileName} style={{ maxWidth: '100%', maxHeight: '100%' }} />
              </Box>
            )}

            {!isPdf && (
              <Box sx={{ mb: 2, p: 2, backgroundColor: 'background.level2', borderRadius: 1 }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={{ xs: 2, sm: 4 }}
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                >
                  <FormControl orientation="horizontal" sx={{ gap: 1 }}>
                    <FormLabel>System Instructions</FormLabel>
                    <Switch
                      checked={systemEnabled}
                      onChange={viewOnly ? undefined : e => setSystemEnabled(e.target.checked)}
                      disabled={viewOnly}
                    />
                  </FormControl>

                  <FormControl orientation="horizontal" sx={{ gap: 1 }}>
                    <FormLabel>Priority</FormLabel>
                    <Input
                      size="sm"
                      type="number"
                      disabled={!systemEnabled || viewOnly}
                      value={systemPriority}
                      onChange={
                        viewOnly
                          ? undefined
                          : e => {
                              const val = parseInt(e.target.value, 10);
                              if (val >= 0 && val <= 999) {
                                setSystemPriority(val);
                              }
                            }
                      }
                      readOnly={viewOnly}
                      slotProps={{
                        input: {
                          min: 0,
                          max: 999,
                        },
                      }}
                      sx={{
                        width: 100,
                        backgroundColor: viewOnly ? 'background.level1' : undefined,
                      }}
                    />
                  </FormControl>

                  <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                    0-100: Global • 101-300: Group • 301-500: Project • 501-999: User
                  </Typography>
                </Stack>
              </Box>
            )}
          </Box>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default KnowledgeModal;

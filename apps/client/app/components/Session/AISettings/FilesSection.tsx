import { Warning as WarningIcon, Delete } from '@mui/icons-material';
import { red } from '@client/app/utils/themes/colors';
import { Badge, Box, CircularProgress, Divider, IconButton, Tooltip, Typography } from '@mui/joy';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { IFabFileDocument, MimeType } from '@bike4mind/common';
import { setKnowledgeViewer } from '@client/app/components/Knowledge/KnowledgeViewer';
import {
  useSessions,
  useSystemPromptFiles,
  useWorkBenchActions,
  useWorkBenchFiles,
  useWorkBenchStore,
} from '@client/app/contexts/SessionsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useChunkFile } from '@client/app/hooks/data/fabFiles';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { useMessageFiles } from '@client/app/hooks/useMessageFiles';
import { renameDuplicateFiles } from '@client/app/utils/fabFileUtils';
import { buildSortedKnowledgeItems } from '@client/app/utils/knowledgeViewerSorting';
import { useQueryClient } from '@tanstack/react-query';

import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CodeIcon from '@mui/icons-material/Code';
import DescriptionIcon from '@mui/icons-material/Description';
import ErrorIcon from '@mui/icons-material/Error';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import LinkIcon from '@mui/icons-material/Link';
import PersonIcon from '@mui/icons-material/Person';
import PublicIcon from '@mui/icons-material/Public';
import TableChartIcon from '@mui/icons-material/TableChart';
import MarkdownIcon from '@mui/icons-material/TextSnippet';

const FileItemContainer = React.forwardRef<HTMLDivElement, { children: React.ReactNode }>(({ children }, ref) => {
  return (
    <Box
      ref={ref}
      sx={theme => ({
        backgroundColor: theme.palette.background.body,
        borderRadius: 5,
        display: 'flex',
        alignItems: 'center',
        p: '8px',
        gap: '12px',
        '&:hover': {
          bgcolor: theme.palette.notebooklist.hoverBg,
        },
        transition: 'background-color 0.2s',
        border: '1px solid',
        borderColor: 'border.light',
      })}
    >
      {children}
    </Box>
  );
});

FileItemContainer.displayName = 'FileItemContainer';

const mimeTypeToIcon: Record<MimeType | 'default', React.JSX.Element | undefined> = {
  'text/plain': <DescriptionIcon />,
  'application/pdf': <InsertDriveFileIcon />,
  'text/csv': <TableChartIcon />,
  'application/json': <CodeIcon />,
  'text/html': <LinkIcon />,
  'text/markdown': <MarkdownIcon />,
  default: <InsertDriveFileIcon />,
};

const getIconForMimeType = (mimeType?: MimeType | string, file?: IFabFileDocument): React.ReactNode => {
  // All icons/images will be wrapped in a fixed-size container for alignment
  const containerSize = 32;
  if (mimeType?.startsWith('image/') && file && (file.fileUrl || file.presignedUrl)) {
    const imageUrl = file.fileUrl || file.presignedUrl;
    return (
      <Box
        sx={{
          width: containerSize,
          height: containerSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Box
          component="img"
          src={imageUrl}
          alt={file.fileName}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: '4px',
            display: 'block',
          }}
        />
      </Box>
    );
  }
  // For SVG icons, center and size them in the same container
  const icon = mimeType ? mimeTypeToIcon[mimeType as MimeType] || mimeTypeToIcon['default'] : mimeTypeToIcon['default'];
  return (
    <Box
      sx={{
        width: containerSize,
        height: containerSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {icon
        ? React.cloneElement(icon, {
            sx: {
              color: (theme: any) => `${theme.palette.text.primary}80`,
              fontSize: '1.5rem',
              flexShrink: 0,
            },
          })
        : icon}
    </Box>
  );
};

// Helper to check if a file was likely auto-detected as plain text
const isAutoDetectedText = (file: IFabFileDocument): boolean => {
  if (file.mimeType !== 'text/plain') return false;
  if (!file.fileName.includes('.')) return true;
  if (file.fileName.endsWith('.txt')) {
    return file.fileName.indexOf('.') === file.fileName.lastIndexOf('.');
  }
  return false;
};

interface FilesSectionProps {
  model: string;
  onEmbeddingMismatchChange?: (hasEmbeddingMismatches: boolean) => void;
}

const FilesSection: React.FC<FilesSectionProps> = ({ model, onEmbeddingMismatchChange }) => {
  const { t } = useTranslation();
  const { currentSessionId, currentSession, setCurrentSession } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId || undefined);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const { systemFiles, globalSystemFileIds, userSystemFileIds } = useSystemPromptFiles();
  const updateSession = useUpdateSession();
  const [loadingChip, setLoadingChip] = useState<{ [id: string]: boolean }>({});
  const [reprocessingFiles, setReprocessingFiles] = useState<{ [id: string]: boolean }>({});
  const isAnyFileReprocessing = Object.values(reprocessingFiles).some(Boolean);
  const { currentUser } = useUser();
  const modelInfo = useModelInfo()?.data?.find(m => m.id === model);
  const currentEmbeddingModel = useGetSettingsValue('defaultEmbeddingModel');
  const defaultChunkSize = useGetSettingsValue('DefaultChunkSize') || 2000;
  const chunkFile = useChunkFile();
  const queryClient = useQueryClient();

  // Files attached to individual messages
  const messageFiles = useMessageFiles(currentSessionId);

  // Get pending message files and artifacts from session layout store
  const pendingMessageFilesRaw = useSessionLayout(s => s.pendingMessageFiles);
  const pendingMessageFiles = useMemo(() => pendingMessageFilesRaw || [], [pendingMessageFilesRaw]);
  const recentArtifacts = useSessionLayout(s => s.recentArtifacts);

  // Memoize sorted knowledge items for consistent ordering
  const sortedKnowledgeItems = useMemo(
    () => buildSortedKnowledgeItems(workBenchFiles, systemFiles, messageFiles, pendingMessageFiles, recentArtifacts),
    [workBenchFiles, systemFiles, messageFiles, pendingMessageFiles, recentArtifacts]
  );

  const isOwnNotebook = useMemo(() => {
    return currentSession?.userId === currentUser?.id || !currentSession;
  }, [currentSession, currentUser]);

  // Check if file has different embedding model than current setting
  const hasEmbeddingMismatch = useCallback(
    (file: IFabFileDocument) => {
      return file.embeddingModel && currentEmbeddingModel && file.embeddingModel !== currentEmbeddingModel;
    },
    [currentEmbeddingModel]
  );

  // Handle reprocessing file with new embedding model
  const handleReprocessFile = useCallback(
    (file: IFabFileDocument) => {
      setReprocessingFiles(prev => ({ ...prev, [file.id]: true }));

      // Check if this is a system file
      const isSystemFile = systemFiles.some(sysFile => sysFile.id === file.id);

      chunkFile.mutate(
        { fabFileId: file.id, chunkSize: Number(defaultChunkSize) }, // Use default chunk size from settings
        {
          onSuccess: () => {
            toast.success(`Successfully reprocessed "${file.fileName}" with the current embedding model`);
            setReprocessingFiles(prev => ({ ...prev, [file.id]: false }));

            if (isSystemFile) {
              // For system files, first manually update the cache data
              queryClient.setQueriesData({ queryKey: ['system-prompt-files'], exact: false }, (oldData: any) => {
                if (Array.isArray(oldData)) {
                  return oldData.map((f: IFabFileDocument) =>
                    f.id === file.id
                      ? { ...f, embeddingModel: String(currentEmbeddingModel), vectorized: true, chunked: true }
                      : f
                  );
                }
                return oldData;
              });

              // Then invalidate after a delay to allow server processing
              setTimeout(() => {
                queryClient.invalidateQueries({
                  queryKey: ['system-prompt-files'],
                  exact: false,
                });

                // Also invalidate any individual file queries
                queryClient.invalidateQueries({
                  queryKey: ['fab-file', file.id],
                  exact: false,
                });
              }, 1500); // 1.5 second delay to allow server to process the file
            } else {
              // Update the file in the workbench store to reflect the new embedding model
              if (currentSessionId) {
                setWorkBenchFiles(currentSessionId, prevFiles =>
                  prevFiles.map(f =>
                    f.id === file.id
                      ? { ...f, embeddingModel: String(currentEmbeddingModel), vectorized: true, chunked: true }
                      : f
                  )
                );
              }
            }
          },
          onError: (error: any) => {
            toast.error(`Failed to reprocess file: ${error?.message || 'Unknown error'}`);
            setReprocessingFiles(prev => ({ ...prev, [file.id]: false }));
          },
        }
      );
    },
    [chunkFile, defaultChunkSize, currentSessionId, setWorkBenchFiles, currentEmbeddingModel, systemFiles, queryClient]
  );

  // Check if the file is supported by the model
  const fileSupported = useCallback(
    (file: IFabFileDocument) => {
      let supported = true;
      if (modelInfo?.type === 'text') {
        if (!modelInfo?.supportsVision && file.mimeType.startsWith('image/')) {
          supported = false;
        }
      } else if (modelInfo?.type === 'image') {
        if (file.mimeType.startsWith('image/')) {
          if (!modelInfo?.supportsImageVariation) {
            supported = false;
          }
        } else {
          supported = false;
        }
      }
      return supported;
    },
    [modelInfo]
  );

  // Remove a FabFile
  const handleRemove = useCallback(
    (id: string) => {
      // Use functional updater to always read fresh state from Zustand
      setWorkBenchFiles(currentSessionId ?? '', prevFiles => prevFiles.filter(file => file.id !== id));

      if (currentSessionId && currentSession) {
        // Get fresh files from Zustand after update
        const freshFiles = useWorkBenchStore.getState().getWorkBenchFiles(currentSessionId);
        const knowledgeIds = freshFiles.map(file => file.id);

        setLoadingChip(prev => ({ ...prev, [id]: true }));
        updateSession
          .mutateAsync({ ...currentSession, knowledgeIds })
          .then(() => {
            // After the DB update succeeds, re-sync knowledgeIds from Zustand so
            // out-of-order API responses can't resurrect deleted files during rapid
            // multi-file deletions.
            const currentKnowledgeIds = useWorkBenchStore
              .getState()
              .getWorkBenchFiles(currentSessionId)
              .map(f => f.id);
            setCurrentSession(prev => (prev ? { ...prev, knowledgeIds: currentKnowledgeIds } : null));
            toast.success(`Removed ${t('file')}`);
          })
          .finally(() => {
            setLoadingChip(prev => ({ ...prev, [id]: false }));
          });
      }
    },
    [currentSessionId, currentSession, updateSession, t, setWorkBenchFiles, setCurrentSession]
  );

  const handleClick = useCallback(
    (index: number) => {
      // First force clear any existing artifact data
      setSessionLayout({
        layout: 'vertical',
        selectedArtifactId: undefined,
        artifactData: undefined,
      });

      // Find the file at the clicked index in the original order
      const clickedFile = workBenchFiles[index];
      // Find its position in the sorted items list
      const sortedIndex = sortedKnowledgeItems.findIndex(item => item.id === clickedFile.id);

      // setTimeout lets the layout change settle before setting the tab index
      if (sortedIndex !== -1) {
        setTimeout(() => {
          setKnowledgeViewer({ selectedTabIndex: sortedIndex });
        }, 0);
      }
    },
    [workBenchFiles, sortedKnowledgeItems]
  );

  const handleSystemFileClick = useCallback(
    (systemFile: IFabFileDocument) => {
      // First force clear any existing artifact data
      setSessionLayout({
        layout: 'vertical',
        selectedArtifactId: undefined,
        artifactData: undefined,
      });

      // Find the system file in the sorted list (using system- prefix)
      const systemFileIndex = sortedKnowledgeItems.findIndex(item => item.id === `system-${systemFile.id}`);

      // setTimeout lets the layout change settle before setting the tab index
      if (systemFileIndex !== -1) {
        setTimeout(() => {
          setKnowledgeViewer({ selectedTabIndex: systemFileIndex });
        }, 0);
      }
    },
    [sortedKnowledgeItems]
  );

  // Helper to determine if a system file is global or user-specific
  const getSystemFileType = (fileId: string) => {
    const isGlobal = globalSystemFileIds.includes(fileId);
    const isUser = userSystemFileIds.includes(fileId);

    if (isGlobal && isUser) return 'duplicate';
    if (isGlobal) return 'global';
    return 'user';
  };

  const allFiles = [...workBenchFiles, ...systemFiles];
  const totalFileCount = allFiles.length;
  // Check if any files have embedding mismatches
  const hasEmbeddingMismatches = useMemo(() => {
    return [...workBenchFiles, ...systemFiles].some(file => hasEmbeddingMismatch(file));
  }, [workBenchFiles, systemFiles, hasEmbeddingMismatch]);

  // Notify parent component when embedding mismatch status changes
  useEffect(() => {
    onEmbeddingMismatchChange?.(hasEmbeddingMismatches);
  }, [hasEmbeddingMismatches, onEmbeddingMismatchChange]);

  if (totalFileCount === 0) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* System Files Section */}
      {systemFiles.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {systemFiles.map((file: IFabFileDocument) => {
            const systemType = getSystemFileType(file.id);
            const embeddingMismatch = hasEmbeddingMismatch(file);
            let tooltipText =
              systemType === 'duplicate'
                ? `${file.fileName} (Duplicate: Global + User System Prompt)`
                : systemType === 'global'
                  ? `${file.fileName} (Global System Prompt)`
                  : `${file.fileName} (User System Prompt)`;

            if (embeddingMismatch) {
              tooltipText = `${file.fileName} (Different embedding model: ${file.embeddingModel})`;
            }

            return (
              <Tooltip key={file.id} title={tooltipText} placement="top" arrow>
                <FileItemContainer>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      cursor: 'pointer',
                      flex: 1,
                      minWidth: 0,
                      transition: 'all 0.15s ease-in-out',
                    }}
                    onClick={() => handleSystemFileClick(file)}
                  >
                    <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      {getIconForMimeType(file.mimeType, file)}
                      <Badge
                        anchorOrigin={{
                          vertical: 'bottom',
                          horizontal: 'right',
                        }}
                        size="sm"
                        sx={{ position: 'absolute', top: -2, right: -2 }}
                      >
                        {systemType === 'global' ? (
                          <PublicIcon sx={{ fontSize: '0.75rem', color: 'primary.500' }} />
                        ) : (
                          <PersonIcon sx={{ fontSize: '0.75rem', color: 'primary.500' }} />
                        )}
                      </Badge>
                    </Box>
                    <Typography level="body-sm" noWrap sx={{ color: theme => theme.palette.text.primary, flex: 1 }}>
                      {file.fileName.length > 30 ? `${file.fileName.slice(0, 30)}...` : file.fileName}
                    </Typography>
                    {file.error && (
                      <Tooltip title={file.error} placement="top" arrow>
                        <WarningIcon sx={{ fontSize: '0.875rem', color: red[400] }} />
                      </Tooltip>
                    )}
                  </Box>
                  {embeddingMismatch && (
                    <Tooltip
                      title="Click here to reprocess this system file for better search and analysis results."
                      placement="top"
                      arrow
                    >
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        disabled={isAnyFileReprocessing || file.isChunking || file.isVectorizing}
                        onClick={e => {
                          e.stopPropagation();
                          handleReprocessFile(file);
                        }}
                        sx={{
                          width: 32,
                          height: 32,
                          minWidth: 32,
                          minHeight: 32,
                          p: 0,
                          m: 0,
                        }}
                      >
                        {reprocessingFiles[file.id] ? (
                          <CircularProgress size="sm" />
                        ) : (
                          <ErrorIcon sx={{ fontSize: '0.75rem' }} />
                        )}
                      </IconButton>
                    </Tooltip>
                  )}
                </FileItemContainer>
              </Tooltip>
            );
          })}
        </Box>
      )}

      {/* Divider between system and session files */}
      {systemFiles.length > 0 && workBenchFiles.length > 0 && <Divider sx={{ my: 1 }} />}

      {/* Session Files Section */}
      {workBenchFiles.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {renameDuplicateFiles(workBenchFiles).map((file, index) => {
            const autoDetected = isAutoDetectedText(file);
            const supported = fileSupported(file);
            const embeddingMismatch = hasEmbeddingMismatch(file);
            let tooltipText = file.fileName;

            if (!supported) {
              tooltipText = 'Selected model does not support this file type';
            } else if (embeddingMismatch) {
              tooltipText = `${file.fileName} (Different embedding model: ${file.embeddingModel})`;
            } else if (autoDetected) {
              tooltipText = `${file.fileName} (Auto-detected as plain text)`;
            }

            return (
              <Tooltip key={file.id} title={tooltipText} placement="top" arrow>
                <FileItemContainer>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      cursor: 'pointer',
                      flex: 1,
                      minWidth: 0,
                      transition: 'all 0.15s ease-in-out',
                    }}
                    onClick={() => handleClick(index)}
                  >
                    <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      {getIconForMimeType(file.mimeType, file)}
                      {autoDetected && (
                        <Badge
                          anchorOrigin={{
                            vertical: 'bottom',
                            horizontal: 'right',
                          }}
                          size="sm"
                          sx={{ position: 'absolute', top: -2, right: -2 }}
                        >
                          <AutoFixHighIcon sx={{ fontSize: '0.75rem', color: 'warning.500' }} />
                        </Badge>
                      )}
                    </Box>
                    <Typography
                      level="body-sm"
                      noWrap
                      sx={{ color: theme => theme.palette.text.primary, flex: 1 }}
                      data-testid="session-file-list"
                    >
                      {file.fileName.length > 30 ? `${file.fileName.slice(0, 30)}...` : file.fileName}
                    </Typography>
                    {file.error && (
                      <Tooltip title={file.error} placement="top" arrow>
                        <WarningIcon sx={{ fontSize: '0.875rem', color: red[400] }} />
                      </Tooltip>
                    )}
                  </Box>
                  {embeddingMismatch && (
                    <Tooltip
                      title="Click here to reprocess this file for better search and analysis results."
                      placement="top"
                      arrow
                    >
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        disabled={isAnyFileReprocessing || file.isChunking || file.isVectorizing}
                        onClick={e => {
                          e.stopPropagation();
                          handleReprocessFile(file);
                        }}
                        sx={{
                          width: 32,
                          height: 32,
                          minWidth: 32,
                          minHeight: 32,
                          p: 0,
                          m: 0,
                        }}
                      >
                        {reprocessingFiles[file.id] ? (
                          <CircularProgress size="sm" />
                        ) : (
                          <ErrorIcon sx={{ fontSize: '0.75rem' }} />
                        )}
                      </IconButton>
                    </Tooltip>
                  )}
                  {(file.userId === currentUser?.id || isOwnNotebook) && (
                    <Box sx={{ display: 'flex', alignItems: 'center', ml: 'auto' }}>
                      {loadingChip[file?.id] ? (
                        <CircularProgress size="sm" sx={{ width: 20, height: 20 }} />
                      ) : (
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={e => {
                            e.stopPropagation();
                            handleRemove(file.id);
                          }}
                          sx={{
                            width: 24,
                            height: 24,
                            minWidth: 24,
                            minHeight: 24,
                            p: 0,
                            m: 0,
                            ml: 0.5,
                          }}
                        >
                          <Delete sx={{ fontSize: '0.875rem' }} />
                        </IconButton>
                      )}
                    </Box>
                  )}
                </FileItemContainer>
              </Tooltip>
            );
          })}
        </Box>
      )}
    </Box>
  );
};

export default FilesSection;

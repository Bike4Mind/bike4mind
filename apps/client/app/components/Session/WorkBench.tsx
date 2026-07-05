import {
  useSessions,
  useWorkBenchFiles,
  useWorkBenchActions,
  useSystemPromptFiles,
  useWorkBenchStore,
} from '@client/app/contexts/SessionsContext';
import { IFabFileDocument, MimeType } from '@bike4mind/common';
import CodeIcon from '@mui/icons-material/Code';
import DescriptionIcon from '@mui/icons-material/Description';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import LinkIcon from '@mui/icons-material/Link';
import TableChartIcon from '@mui/icons-material/TableChart';
import MarkdownIcon from '@mui/icons-material/TextSnippet';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import FolderIcon from '@mui/icons-material/Folder';
import CloseIcon from '@mui/icons-material/Close';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import PublicIcon from '@mui/icons-material/Public';
import PersonIcon from '@mui/icons-material/Person';
import { CircularProgress, Divider, Tooltip, Typography, Badge, IconButton } from '@mui/joy';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Grid from '@mui/joy/Grid';
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { setKnowledgeViewer } from '../Knowledge/KnowledgeViewer';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useUser } from '@client/app/contexts/UserContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { renameDuplicateFiles } from '@client/app/utils/fabFileUtils';
import { useModelInfo } from '../../hooks/data/useModelInfo';
import { useTranslation } from 'react-i18next';

const mimeTypeToIcon: Record<MimeType | 'default', React.ReactNode> = {
  'text/plain': <DescriptionIcon />,
  'application/pdf': <InsertDriveFileIcon />,
  'text/csv': <TableChartIcon />,
  'application/json': <CodeIcon />,
  'text/html': <LinkIcon />,
  'text/markdown': <MarkdownIcon />,
  default: <InsertDriveFileIcon />,
};

const getIconForMimeType = (mimeType?: MimeType | string): React.ReactNode => {
  return mimeType ? mimeTypeToIcon[mimeType as MimeType] || mimeTypeToIcon['default'] : mimeTypeToIcon['default'];
};

// A file auto-detected as plain text: text/plain with no extension, or a
// single-period .txt name (name.txt, not name.something.txt).
const isAutoDetectedText = (file: IFabFileDocument): boolean => {
  if (file.mimeType !== 'text/plain') return false;

  if (!file.fileName.includes('.')) {
    return true;
  }

  // Only .txt with a single period counts (name.txt, not name.something.txt).
  if (file.fileName.endsWith('.txt')) {
    return file.fileName.indexOf('.') === file.fileName.lastIndexOf('.');
  }

  return false;
};

export type WorkBenchProps = {
  model: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

export const CollapsedWorkBench: React.FC<{ fileCount: number; systemFileCount: number; onClick: () => void }> = ({
  fileCount,
  systemFileCount,
  onClick,
}) => {
  const { t } = useTranslation();

  const getTooltipText = () => {
    if (systemFileCount > 0 && fileCount > 0) {
      return t('files.showAttachedFiles') + ' & System Prompts';
    } else if (systemFileCount > 0) {
      return 'Show System Prompts';
    } else {
      return t('files.showAttachedFiles');
    }
  };

  return (
    <Tooltip title={getTooltipText()}>
      <IconButton
        variant="soft"
        color="primary"
        onClick={onClick}
        sx={{
          borderRadius: '50%',
          position: 'relative',
          transition: 'transform 0.2s ease-in-out',
          '&:hover': {
            transform: 'scale(1.05)',
          },
          animation: 'fadeIn 0.3s ease-in-out',
          '@keyframes fadeIn': {
            '0%': {
              opacity: 0,
              transform: 'translateY(-10px)',
            },
            '100%': {
              opacity: 1,
              transform: 'translateY(0)',
            },
          },
        }}
      >
        <FolderIcon />
        {fileCount > 0 && (
          <Badge
            badgeContent={fileCount === 1 ? '' : String(fileCount)}
            color="success"
            size="sm"
            sx={{
              position: 'absolute',
              top: '30px',
              right: '8px',
              transform: 'translate(25%, -25%)',
              '& .MuiBadge-badge': {
                fontSize: '0.7rem',
                minWidth: '18px',
                height: '18px',
              },
            }}
          />
        )}
        {systemFileCount > 0 && (
          <Badge
            badgeContent={systemFileCount === 1 ? '' : String(systemFileCount)}
            color="primary"
            size="sm"
            sx={{
              position: 'absolute',
              top: '30px',
              left: '8px',
              transform: 'translate(-25%, -25%)',
              '& .MuiBadge-badge': {
                fontSize: '0.7rem',
                minWidth: '18px',
                height: '18px',
              },
            }}
          />
        )}
      </IconButton>
    </Tooltip>
  );
};

const WorkBench: React.FC<WorkBenchProps> = ({ model, collapsed = false, onToggleCollapse }) => {
  const { setCurrentSession, currentSessionId, currentSession } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId || undefined);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const { systemFiles, globalSystemFileIds, userSystemFileIds } = useSystemPromptFiles();
  const updateSession = useUpdateSession();
  const { t } = useTranslation();
  const [loadingChip, setLoadingChip] = useState<{ [id: string]: boolean }>({});
  const { currentUser } = useUser();
  const modelInfo = useModelInfo()?.data?.find(m => m.id === model);
  const [lastModifiedInit] = useState(() => Date.now());
  const lastModifiedRef = useRef(lastModifiedInit);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [userInteracted, setUserInteracted] = useState(false);

  const isOwnNotebook = useMemo(() => {
    return currentSession?.userId === currentUser?.id || !currentSession;
  }, [currentSession, currentUser]);

  useEffect(() => {
    if (collapsed) {
      setIsExiting(false);
    }
  }, [collapsed]);

  // Define handleCollapse first so it can be used in resetTimer
  const handleCollapse = useCallback(() => {
    if (onToggleCollapse) {
      setIsExiting(true);
      // Wait for animation to complete before actually collapsing
      setTimeout(() => {
        onToggleCollapse();
      }, 280);
    }
  }, [onToggleCollapse]);

  const resetTimer = useCallback(() => {
    // Do not set timer if already collapsed
    if (collapsed) return;
    lastModifiedRef.current = Date.now();
    setUserInteracted(true);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      // Read the store directly to avoid adding files to the callback deps.
      const store = useWorkBenchStore.getState();
      const currentFiles = store.getWorkBenchFiles(currentSessionId || '');
      if (currentFiles.length > 0) {
        handleCollapse();
      }
    }, 3000);
  }, [handleCollapse, collapsed, currentSessionId]);

  // Ref to the latest resetTimer so effects can call it without depending on it.
  const resetTimerRef = useRef(resetTimer);
  useEffect(() => {
    resetTimerRef.current = resetTimer;
  }, [resetTimer]);

  // Auto-hide on file changes; call resetTimer via ref to avoid a circular dep.
  useEffect(() => {
    if (!collapsed && workBenchFiles.length > 0) {
      resetTimerRef.current();
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [workBenchFiles.length, collapsed]); // resetTimer intentionally omitted (called via ref)

  useEffect(() => {
    if (userInteracted) {
      setUserInteracted(false);
    }
  }, [userInteracted]);

  const handleRemove = useCallback(
    (id: string) => {
      resetTimerRef.current();
      const newWorkBenchFiles = workBenchFiles.filter(file => file.id !== id);
      const knowledgeIds = newWorkBenchFiles.map(file => file.id);

      setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);

      if (currentSessionId && currentSession) {
        setLoadingChip(prev => ({ ...prev, [id]: true }));
        updateSession
          .mutateAsync({ ...currentSession, knowledgeIds })
          .then(value => {
            setCurrentSession(value);
            toast.success(`Removed ${t('file')}`);
          })
          .finally(() => {
            setLoadingChip(prev => ({ ...prev, [id]: false }));
          });
      }
    },
    [workBenchFiles, currentSessionId, currentSession, updateSession, setCurrentSession, t, setWorkBenchFiles] // resetTimer intentionally omitted (called via ref)
  );

  // False if the model can't handle the file (e.g. an image on a non-vision model).
  const fileSupported = (file: IFabFileDocument) => {
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
  };

  const handleClick = useCallback(
    (index: number) => {
      resetTimerRef.current();

      setSessionLayout({
        layout: 'vertical',
        selectedArtifactId: undefined,
        artifactData: undefined,
      });

      // Sort by timestamp to match KnowledgeViewer's order.
      const sortedFiles = [...workBenchFiles].sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
        return timeB - timeA;
      });

      const clickedFile = workBenchFiles[index];
      const sortedIndex = sortedFiles.findIndex(file => file.id === clickedFile.id);

      setTimeout(() => {
        setKnowledgeViewer({ selectedTabIndex: sortedIndex });
      }, 0);
    },
    [workBenchFiles] // resetTimer intentionally omitted (called via ref)
  );

  const handleSystemFileClick = useCallback(
    (systemFile: IFabFileDocument) => {
      resetTimerRef.current();

      setSessionLayout({
        layout: 'vertical',
        selectedArtifactId: undefined,
        artifactData: undefined,
      });

      // KnowledgeViewer lists workBenchFiles + systemFiles + artifactData sorted
      // by timestamp (newest first); find this file's index in that order.
      const allFiles = [...workBenchFiles, ...systemFiles];
      const sortedFiles = allFiles.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
        return timeB - timeA;
      });

      const systemFileIndex = sortedFiles.findIndex(file => file.id === systemFile.id);

      setTimeout(() => {
        setKnowledgeViewer({ selectedTabIndex: systemFileIndex });
      }, 0);
    },
    [workBenchFiles, systemFiles] // resetTimer intentionally omitted (called via ref)
  );

  const getSystemFileType = (fileId: string) => {
    const isGlobal = globalSystemFileIds.includes(fileId);
    const isUser = userSystemFileIds.includes(fileId);

    if (isGlobal && isUser) return 'duplicate';
    if (isGlobal) return 'global';
    return 'user';
  };

  if (workBenchFiles.length === 0 && systemFiles.length === 0) return null;
  if (collapsed) return null;

  return (
    <Box
      sx={{
        overflow: 'hidden',
        maxHeight: isExiting ? '0px' : '500px',
        opacity: isExiting ? 0 : 1,
        transition: 'max-height 300ms ease-out, opacity 280ms ease-out',
        width: '100%',
        position: 'relative',
      }}
      onMouseEnter={() => resetTimerRef.current()}
      onMouseMove={() => resetTimerRef.current()}
    >
      {/* Corner close button */}
      {onToggleCollapse && (
        <Tooltip title="Close">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={handleCollapse}
            data-testid="workbench-close-btn-corner"
            sx={{
              position: 'absolute',
              top: '4px',
              right: '4px',
              zIndex: 10,
              minWidth: 'auto',
              minHeight: 'auto',
              padding: '4px',
              '--IconButton-size': '24px',
              opacity: 0.7,
              transition: 'opacity 0.2s ease, background-color 0.2s ease',
              '&:hover': {
                opacity: 1,
                backgroundColor: 'neutral.softHoverBg',
              },
            }}
          >
            <CloseIcon sx={{ fontSize: '18px' }} />
          </IconButton>
        </Tooltip>
      )}
      <Box
        display={'flex'}
        flexDirection={'column'}
        gap={2}
        sx={{
          marginY: '0.938rem',
          width: '100%',
          animation: 'fadeIn 300ms ease-out',
          '@keyframes fadeIn': {
            '0%': {
              opacity: 0,
              transform: 'translateY(-10px)',
            },
            '100%': {
              opacity: 1,
              transform: 'translateY(0)',
            },
          },
        }}
      >
        {/* Header with collapse button */}
        {onToggleCollapse && (
          <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              {systemFiles.length > 0 && workBenchFiles.length > 0
                ? 'System & Session Files'
                : systemFiles.length > 0
                  ? 'System Files'
                  : 'Session Files'}
            </Typography>
            <Tooltip title="Close">
              <IconButton
                size="sm"
                variant="soft"
                color="neutral"
                onClick={handleCollapse}
                data-testid="workbench-close-btn"
                sx={{
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    backgroundColor: 'neutral.softHoverBg',
                  },
                }}
              >
                <CloseIcon />
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {/* System Prompt Files Section */}
        {systemFiles.length > 0 && (
          <Box>
            {!onToggleCollapse && (
              <Typography level="body-xs" sx={{ mb: 1, color: 'text.secondary' }}>
                System Prompts
              </Typography>
            )}
            <Grid container gap={'0.625rem'} direction={'row'} sx={{ width: '100%' }}>
              {systemFiles.map((file: IFabFileDocument) => {
                const systemType = getSystemFileType(file.id);
                const tooltipText =
                  systemType === 'duplicate'
                    ? `${file.fileName} (Duplicate: Global + User System Prompt)`
                    : systemType === 'global'
                      ? `${file.fileName} (Global System Prompt)`
                      : `${file.fileName} (User System Prompt)`;

                return (
                  <Tooltip key={file.id} title={tooltipText} placement="top">
                    <Chip
                      variant="solid"
                      color={systemType === 'duplicate' ? 'warning' : 'primary'}
                      sx={{
                        padding: '4px',
                        paddingX: '12px',
                        borderRadius: '50px',
                        opacity: systemType === 'duplicate' ? 0.8 : 1,
                        cursor: 'pointer',
                        transition: 'transform 0.15s ease-in-out',
                        '&:hover': {
                          transform: 'translateY(-2px)',
                        },
                      }}
                      onClick={() => handleSystemFileClick(file)}
                      startDecorator={
                        <>
                          {getIconForMimeType(file.mimeType)}
                          <Badge
                            anchorOrigin={{
                              vertical: 'bottom',
                              horizontal: 'right',
                            }}
                            size="sm"
                            sx={{ ml: -1.5, mb: -0.5 }}
                          >
                            {systemType === 'global' ? (
                              <PublicIcon sx={{ fontSize: '0.75rem', color: 'primary.200' }} />
                            ) : (
                              <PersonIcon sx={{ fontSize: '0.75rem', color: 'primary.200' }} />
                            )}
                          </Badge>
                        </>
                      }
                    >
                      <Typography level="body-sm" sx={{ fontWeight: 500, color: 'white' }}>
                        {file.fileName.length > 20 ? `${file.fileName.slice(0, 10)}...` : file.fileName}
                      </Typography>
                    </Chip>
                  </Tooltip>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* Regular Workbench Files Section */}
        {workBenchFiles.length > 0 && (
          <Box>
            {systemFiles.length > 0 && (
              <Typography level="body-xs" sx={{ mb: 1, color: 'text.secondary' }}>
                Session Files
              </Typography>
            )}
            <Grid container gap={'0.625rem'} direction={'row'} sx={{ width: 'calc(100% - 40px)' }}>
              {renameDuplicateFiles(workBenchFiles).map((file, index) => {
                const autoDetected = isAutoDetectedText(file);
                const tooltipText = autoDetected
                  ? `${file.fileName} (Auto-detected as plain text)`
                  : fileSupported(file)
                    ? file.fileName
                    : 'Selected model does not support this file type';

                return (
                  <Tooltip key={file.id} title={tooltipText} placement="top">
                    <Chip
                      variant="solid"
                      color={fileSupported(file) ? 'success' : 'secondary'}
                      sx={{
                        padding: '4px',
                        paddingX: '12px',
                        borderRadius: '50px',
                        transition: 'transform 0.15s ease-in-out',
                        '&:hover': {
                          transform: 'translateY(-2px)',
                        },
                      }}
                      onClick={() => handleClick(index)}
                      startDecorator={
                        <>
                          {getIconForMimeType(file.mimeType)}
                          {autoDetected && (
                            <Badge
                              anchorOrigin={{
                                vertical: 'bottom',
                                horizontal: 'right',
                              }}
                              size="sm"
                              sx={{ ml: -1.5, mb: -0.5 }}
                            >
                              <AutoFixHighIcon sx={{ fontSize: '0.75rem', color: 'warning.500' }} />
                            </Badge>
                          )}
                        </>
                      }
                      endDecorator={
                        (file.userId === currentUser?.id || isOwnNotebook) && (
                          <div style={{ height: '22px', minHeight: '22px' }}>
                            {loadingChip[file?.id] && (
                              <CircularProgress size="sm" sx={{ width: '22px', height: '22px' }} />
                            )}
                            {!loadingChip[file?.id] && (
                              <IconButton
                                size="sm"
                                variant="plain"
                                onClick={e => {
                                  e.stopPropagation();
                                  handleRemove(file.id);
                                }}
                                sx={{
                                  minWidth: 'auto',
                                  minHeight: 'auto',
                                  padding: '2px',
                                  '--IconButton-size': '20px',
                                  color: 'white',
                                  '&:hover': {
                                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                  },
                                }}
                                data-testid={`remove-file-${file.id}`}
                              >
                                <RemoveCircleOutlineIcon sx={{ fontSize: '18px' }} />
                              </IconButton>
                            )}
                          </div>
                        )
                      }
                    >
                      <Typography color="secondary" level="body-sm">
                        {file.fileName.length > 20 ? `${file.fileName.slice(0, 10)}...` : file.fileName}
                      </Typography>
                    </Chip>
                  </Tooltip>
                );
              })}
            </Grid>
          </Box>
        )}
      </Box>

      <Divider sx={{ mt: 0, backgroundColor: 'chatbox.messageInputDivider' }} />
    </Box>
  );
};

export default WorkBench;

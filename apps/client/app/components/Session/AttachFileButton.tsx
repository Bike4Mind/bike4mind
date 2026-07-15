import { IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { useUser } from '@client/app/contexts/UserContext';
import { useConnectGoogleDrive } from '@client/app/hooks/data/googleDrive';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import SiGoogledrive, { defaultColor as SiGoogledriveHex } from '@icons-pack/react-simple-icons/icons/SiGoogledrive';
import { AttachFile, ArrowBack, InsertDriveFileOutlined } from '@mui/icons-material';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import CasinoIcon from '@mui/icons-material/Casino';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import {
  Box,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemDecorator,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import axios from 'axios';
import AddIcon from '@mui/icons-material/Add';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import PostAddIcon from '@mui/icons-material/PostAdd';
import useDrivePicker from 'react-google-drive-picker';
import { toast } from 'sonner';
import ScienceIcon from '@mui/icons-material/Science';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import { useAdvancedAISettings } from '@client/app/components/Session/AdvancedAISettings';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useState, useRef, useEffect } from 'react';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useCreateNewSession, useUpdateSession } from '@client/app/hooks/data/sessions';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MiscEvents } from '@bike4mind/common';
import { RollCommandArgs, handleRollCommand } from '@client/app/components/commands/RollCommand';
import { useShallow } from 'zustand/react/shallow';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useGetSessionAgents } from '@client/app/hooks/data/agents';
import CountBadge from '@client/app/components/common/CountBadge';

const GOOGLE_DRIVE_PICKER_STYLE_ID = 'b4m-google-drive-picker-styles';

const ensureGoogleDrivePickerStyles = () => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(GOOGLE_DRIVE_PICKER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GOOGLE_DRIVE_PICKER_STYLE_ID;
  style.textContent = `
    .picker-dialog,
    .picker-dialog-bg,
    .google-picker-dialog {
      z-index: 1400 !important;
    }

    /* Improve file type icons */
    .picker-spr-generic-file,
    .picker-spr-unknown-file {
      background: #f1f3f4 !important;
      border-radius: 2px !important;
      position: relative !important;
    }

    /* Google Docs icon */
    .picker-spr-doc-icon {
      background: #4285f4 !important;
      border-radius: 2px !important;
    }

    /* Google Sheets icon */
    .picker-spr-spreadsheet-icon {
      background: #0f9d58 !important;
      border-radius: 2px !important;
    }

    /* PDF icon */
    .picker-spr-pdf-icon {
      background: #ea4335 !important;
      border-radius: 2px !important;
    }

    /* Fallback for missing thumbnails */
    .picker-photo-control-default {
      background: #f8f9fa !important;
      border: 1px solid #dadce0 !important;
      border-radius: 4px !important;
    }
  `;
  document.head.appendChild(style);
};

ensureGoogleDrivePickerStyles();

interface IProps {
  onUploadFromComputer: () => void;
  onAddFromGoogleDrive: (fabFile: IFabFileDocument) => void;
  onAddFromFileBrowser: () => void;
  isSessionFileMode: boolean;
  onToggleFileMode: (checked: boolean) => void;
  totalFilesCount?: number;
  chatInputValue?: string;
  onOptimizePrompt?: () => void;
}

const AttachFileButton = ({
  onUploadFromComputer,
  onAddFromGoogleDrive,
  onAddFromFileBrowser,
  isSessionFileMode,
  onToggleFileMode,
  totalFilesCount,
  chatInputValue,
  onOptimizePrompt,
}: IProps) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: config } = useConfig();
  const { googleClientId } = config || {};
  const [openPicker] = useDrivePicker();

  const currentUser = useUser(state => state.currentUser);
  const [currentView, setCurrentView] = useState<'main' | 'other-apps'>('main');
  const [isOpen, setIsOpen] = useState(false);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const connectGoogleDrive = useConnectGoogleDrive();
  const isMobile = useIsMobile();
  const logEvent = useLogEvent();
  const createNewSession = useCreateNewSession();
  const updateSession = useUpdateSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const {
    currentSession,
    setCurrentSession,
    setCurrentSessionId,
    workBenchAgents,
    setWorkBenchAgents,
    currentSessionId,
  } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();

  const isGoogleDriveConnected = !!currentUser?.googleDrive;

  // Get agents count for mobile badge
  const { data: sessionAgents = [] } = useGetSessionAgents(currentSessionId);
  const activeAgentsCount = currentSessionId ? sessionAgents.length : workBenchAgents.length;

  // Get tool state from LLM context
  const [tools] = useLLM(useShallow(state => [state.tools]));

  // Advanced AI Settings modal control
  const openAdvancedSettings = useAdvancedAISettings(s => s.openModal);
  const setAgentsDropdownOpen = useAdvancedAISettings(s => s.setAgentsDropdownOpen);
  const setSessionFilesOpen = useAdvancedAISettings(s => s.setSessionFilesOpen);

  const { isFeatureEnabled } = useFeatureEnabled();
  const isAgentsEnabled = isFeatureEnabled('enableAgents');

  const { settings: userSettings } = useUserSettings();
  const isResearchModeFeatureEnabled = userSettings.experimentalFeatures?.enableResearchMode === true;

  const handleOpenPicker = async () => {
    const { data } = await api.get<{ accessToken?: string; authUrl?: string }>('/api/google-drive/token');

    if (!!data.authUrl) {
      window.location.href = data.authUrl;
    }

    const accessToken = data.accessToken;

    if (!accessToken || !googleClientId) {
      toast.error('Something went wrong. Please try again later.');
      return;
    }

    openPicker({
      clientId: googleClientId,
      developerKey: '',
      viewMimeTypes: '',
      token: accessToken,
      showUploadFolders: true,
      supportDrives: true,
      multiselect: false,
      setIncludeFolders: true,
      setSelectFolderEnabled: false,
      disableDefaultView: false,
      callbackFunction: async data => {
        if (data.action === 'cancel') {
          return;
        }

        if (data.action === 'picked') {
          setIsProcessingFile(true);
          toast.info(`Processing "${data.docs[0].name}"...`);
          const document = data.docs[0];

          try {
            let downloadUrl = `https://www.googleapis.com/drive/v3/files/${document.id}?alt=media`;

            // Check if it's a Google Spreadsheet
            if (document.mimeType === 'application/vnd.google-apps.spreadsheet') {
              // Use the export API to download as .xlsx
              downloadUrl = `https://www.googleapis.com/drive/v3/files/${document.id}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
            }

            if (document.mimeType === 'application/vnd.google-apps.document') {
              // Use the export API to download as .docx
              downloadUrl = `https://www.googleapis.com/drive/v3/files/${document.id}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`;
            }

            const response = await axios.get(downloadUrl, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              responseType: 'blob', // Make sure the response is treated as a blob
            });

            const blob = new Blob([response.data], { type: response.data.type });
            const file = new File([blob], document.name, { type: response.data.type });

            // Create a FabFile from the Google Drive file
            const data = {
              type: KnowledgeType.FILE,
              fileName: file.name,
              mimeType: file.type,
              fileSize: file.size,
            };
            const fabFile = await createFabFileOnServerWithUpload(data, file);

            // Add to workbench files first (this makes files available to LLM)
            setWorkBenchFiles(currentSessionId ?? '', prev => [...prev, fabFile]);

            // Update session if we have one
            if (currentSession) {
              const updatedKnowledgeIds = [...(currentSession.knowledgeIds || []), fabFile.id];
              const updatedSession = { ...currentSession, knowledgeIds: updatedKnowledgeIds };

              // Update session on server
              updateSession.mutate(updatedSession, {
                onSuccess: () => {
                  setCurrentSession(updatedSession);
                  toast.success(`Added "${fabFile.fileName}" to your session`);
                  setIsOpen(false);
                },
                onError: error => {
                  console.error('Failed to update session:', error);
                  toast.error('File uploaded but failed to add to session. Please try again.');
                  setIsOpen(false);
                },
              });
            } else {
              toast.success(`Added "${fabFile.fileName}" to your workbench`);
              setIsOpen(false);
            }

            // Optimistically add to file browser cache
            queryClient.setQueriesData({ queryKey: ['fabFiles'] }, (oldData: any) => {
              if (!oldData?.pages?.[0]?.data) return oldData;
              return {
                ...oldData,
                pages: oldData.pages.map((page: any, index: number) => {
                  if (index === 0) {
                    return {
                      ...page,
                      data: [fabFile, ...page.data],
                      total: page.total + 1,
                    };
                  }
                  return page;
                }),
              };
            });

            // Call the callback (this updates UI components like workbench display)
            onAddFromGoogleDrive(fabFile);
          } catch (error) {
            console.error('Error downloading file:', error);
            toast.error('Error downloading file. Please try again later.');
            setIsOpen(false);
          } finally {
            setIsProcessingFile(false);
          }
        }
      },
    });
  };

  const rollRandomDice = async () => {
    logEvent.mutate({ type: MiscEvents.ROLLED_DICE });

    let session = currentSession;
    if (!session) {
      session = await createNewSession.mutateAsync();

      // Clear workBench agents since they're now attached to the session during creation
      if (workBenchAgents.length > 0) {
        setWorkBenchAgents([]);
        console.log(`🤖 Cleared ${workBenchAgents.length} workBench agents after session creation`);
      }

      // Immediately update the currentSessionId to prepare WebSocket subscriptions
      if (session) {
        setCurrentSessionId(session.id);
        setCurrentSession(session);
      }
    }
    if (!session) {
      console.error('Error creating new session');
      return;
    }

    const args: RollCommandArgs = {
      params: '', // No params provided, it will be generated inside handleRollCommand
      currentSession: session,
      queryClient,
    };
    handleRollCommand(args);
    if (currentSessionId === null) {
      navigate({ to: `/notebooks/${session.id}` });
    }
  };

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isOpen &&
        dropdownRef.current &&
        buttonRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setCurrentView('main');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <Box sx={{ position: 'relative', display: 'inline-block' }}>
      <Tooltip title="Attach Files" placement="top">
        <IconButton
          data-testid="attach-files-btn"
          ref={buttonRef}
          variant="outlined"
          color="neutral"
          size="sm"
          onClick={() => setIsOpen(!isOpen)}
          sx={{ zIndex: 100 }}
        >
          {isMobile ? <AddIcon sx={{ fontSize: 16 }} /> : <AttachFile sx={{ fontSize: '18px' }} />}
        </IconButton>
      </Tooltip>

      {isOpen && (
        <Box
          ref={dropdownRef}
          sx={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            mb: 0.5,
            width: { xs: 'calc(100vw - 32px)', sm: '400px' },
            backgroundColor: 'background.surface',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'sm',
            boxShadow: 'md',
            zIndex: 1000,
            p: isMobile ? '0.75rem' : '0.5rem',
          }}
        >
          {/* File Upload Mode Toggle */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              mb: 1.5,
              pb: 1,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Switch
              data-testid="notebook-context-switch"
              checked={isSessionFileMode}
              onChange={event => onToggleFileMode(event.target.checked)}
            />
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              Add as Notebook Context
            </Typography>
          </Box>

          <List sx={{ '--List-padding': '0px' }}>
            {currentView === 'main' ? (
              <>
                {/* Open the Knowledge Base (Knowledge Viewer) for the current session.
                    Previously the only way in was the "Open in Knowledge Viewer" button on
                    an artifact card — this surfaces it directly so users can browse session
                    files, generated files, and recent artifacts without needing one first. */}
                {currentSessionId && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      data-testid="open-knowledge-base-btn"
                      onClick={() => {
                        setIsOpen(false);
                        setCurrentView('main');
                        setSessionLayout({ layout: 'vertical' });
                      }}
                      sx={{
                        color: 'text.primary',
                        paddingX: '12px',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <MenuBookIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Open Knowledge Base
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Research Mode (opens Research Mode tab in Advanced Settings) */}
                {isResearchModeFeatureEnabled && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      onClick={() => {
                        setIsOpen(false);
                        setCurrentView('main');
                        openAdvancedSettings('research-mode');
                      }}
                      sx={{
                        color: 'text.primary',
                        paddingX: '12px',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <ScienceIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Research Mode
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Mobile only - Agents */}
                {isMobile && isAgentsEnabled && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      onClick={() => {
                        setIsOpen(false);
                        setCurrentView('main');
                        setAgentsDropdownOpen(true);
                      }}
                      sx={{
                        color: 'text.primary',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <SmartToyIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Agents
                      <CountBadge count={activeAgentsCount} prefix="" margin={{ ml: 'auto' }} />
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Mobile only - Session Files */}
                {isMobile && !!totalFilesCount && totalFilesCount > 0 && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      onClick={() => {
                        setIsOpen(false);
                        setCurrentView('main');
                        setSessionFilesOpen(true);
                      }}
                      sx={{
                        color: 'text.primary',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <InsertDriveFileOutlined sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Session Files
                      <CountBadge count={totalFilesCount ?? 0} prefix="" margin={{ ml: 'auto' }} />
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Mobile only - Optimize Prompt */}
                {isMobile && chatInputValue && chatInputValue.trim() !== '' && onOptimizePrompt && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      onClick={() => {
                        setIsOpen(false);
                        setCurrentView('main');
                        onOptimizePrompt();
                      }}
                      sx={{
                        color: 'text.primary',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <AutoAwesomeOutlinedIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Optimize Prompt
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Desktop only, google drive */}
                {!isMobile && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      disabled={isProcessingFile}
                      onClick={() => {
                        if (!isProcessingFile) {
                          setCurrentView('main');
                          if (isGoogleDriveConnected) {
                            handleOpenPicker();
                          } else {
                            connectGoogleDrive.mutate();
                          }
                        }
                      }}
                      sx={{
                        color: 'text.primary',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <SiGoogledrive color={SiGoogledriveHex} size={18} />
                      </ListItemDecorator>
                      {isProcessingFile
                        ? 'Processing file...'
                        : isGoogleDriveConnected
                          ? 'Upload from Google Drive'
                          : 'Connect Google Drive'}
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Mobile only - add from Other Apps */}
                {isMobile && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      onClick={() => {
                        setCurrentView('other-apps');
                      }}
                      sx={{
                        color: 'text.primary',
                        m: 0,
                      }}
                    >
                      <ListItemDecorator>
                        <DragIndicatorIcon style={{ color: 'var(--joy-palette-text-primary50)', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Add from other apps
                    </ListItemButton>
                  </ListItem>
                )}

                {/* Files Section */}
                <ListItem sx={{ p: 0 }}>
                  <ListItemButton
                    data-testid="add-from-file-browser-btn"
                    onClick={() => {
                      setIsOpen(false);
                      setCurrentView('main');
                      onAddFromFileBrowser();
                    }}
                    sx={{
                      color: 'text.primary',
                      m: 0,
                    }}
                  >
                    <ListItemDecorator>
                      <FolderSharedIcon
                        sx={{
                          color: 'text.primary50',
                          fontSize: '18px',
                        }}
                      />
                    </ListItemDecorator>
                    Add from File Browser
                  </ListItemButton>
                </ListItem>

                <ListItem sx={{ p: 0 }}>
                  <ListItemButton
                    data-testid="upload-from-device-btn"
                    onClick={() => {
                      setIsOpen(false);
                      setCurrentView('main');
                      onUploadFromComputer();
                    }}
                    sx={{
                      color: 'text.primary',
                      m: 0,
                    }}
                  >
                    <ListItemDecorator>
                      <PostAddIcon
                        style={{
                          color: 'var(--joy-palette-text-primary50)',
                          fontSize: '18px',
                        }}
                      />
                    </ListItemDecorator>
                    {isMobile ? 'Add from device' : 'Upload from Computer'}
                  </ListItemButton>
                </ListItem>
              </>
            ) : currentView === 'other-apps' ? (
              <>
                {/* Other Apps View */}
                {/* Back Button */}
                <ListItem sx={{ p: 0 }}>
                  <ListItemButton
                    onClick={() => {
                      setCurrentView('main');
                    }}
                    sx={{
                      color: 'text.primary',
                      borderBottom: '1px solid',
                      borderColor: 'divider',
                      mb: 0.5,
                    }}
                  >
                    <ListItemDecorator>
                      <ArrowBack
                        sx={{
                          color: 'text.primary50',
                          fontSize: '18px',
                        }}
                      />
                    </ListItemDecorator>
                    Back
                  </ListItemButton>
                </ListItem>

                {/* Google Drive */}
                <ListItem sx={{ p: 0 }}>
                  <ListItemButton
                    disabled={isProcessingFile}
                    onClick={() => {
                      if (!isProcessingFile) {
                        setCurrentView('main');
                        if (isGoogleDriveConnected) {
                          handleOpenPicker();
                        } else {
                          connectGoogleDrive.mutate();
                        }
                      }
                    }}
                    sx={{
                      color: 'text.primary',
                      m: 0,
                    }}
                  >
                    <ListItemDecorator>
                      <SiGoogledrive color={SiGoogledriveHex} size={18} />
                    </ListItemDecorator>
                    {isProcessingFile
                      ? 'Processing file...'
                      : isGoogleDriveConnected
                        ? 'Upload from Google Drive'
                        : 'Connect Google Drive'}
                  </ListItemButton>
                </ListItem>
              </>
            ) : null}

            {/* Mobile only - roll dice */}
            {isMobile && tools.includes('dice_roll') && currentView === 'main' && (
              <ListItem sx={{ p: 0 }}>
                <ListItemButton
                  onClick={() => {
                    setIsOpen(false);
                    setCurrentView('main');
                    rollRandomDice();
                  }}
                  sx={{
                    color: 'text.primary',
                    m: 0,
                  }}
                >
                  <ListItemDecorator>
                    <CasinoIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                  </ListItemDecorator>
                  Roll Dice
                </ListItemButton>
              </ListItem>
            )}
          </List>
        </Box>
      )}
    </Box>
  );
};
export default AttachFileButton;

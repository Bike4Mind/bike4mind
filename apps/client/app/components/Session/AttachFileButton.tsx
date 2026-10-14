import { IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { useUser } from '@client/app/contexts/UserContext';
import { useConnectGoogleDrive } from '@client/app/hooks/data/googleDrive';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import SiGoogledrive, { defaultColor as SiGoogledriveHex } from '@icons-pack/react-simple-icons/icons/SiGoogledrive';
import {
  ArrowBack,
  Bolt as BoltIcon,
  ChevronRight as ChevronRightIcon,
  ImageOutlined as ImageOutlinedIcon,
  InsertDriveFileOutlined,
  SettingsOutlined as SettingsOutlinedIcon,
  WorkOutline as BriefcaseIcon,
} from '@mui/icons-material';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import CasinoIcon from '@mui/icons-material/Casino';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import {
  Box,
  IconButton,
  List,
  ListDivider,
  ListItem,
  ListItemButton,
  ListItemDecorator,
  Radio,
  RadioGroup,
  Switch,
  Tooltip,
  Typography,
  useTheme,
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
import { isToolDenied } from '@client/app/utils/toolMapping';
import { FC, useState, useRef, useEffect } from 'react';
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
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { ensureGoogleDrivePickerStyles } from '@client/app/utils/googleDrivePickerStyles';
import { isImageModel } from '@client/app/utils/commands';
import { BriefcasePanel } from '@client/app/components/Briefcase/BriefcasePanel';
import ImageOptionsPanel from '@client/app/components/Session/AISettings/ImageOptionsPanel';

import { ATTACH_SCOPE_MODES, type AttachScopeMode } from '@bike4mind/common';
import { brandAlpha, grayAlpha } from '@client/app/utils/themes/colors';

ensureGoogleDrivePickerStyles();

// Keyed by the union, so adding a mode to ATTACH_SCOPE_MODES fails the build here
// until it has copy, rather than rendering an unlabeled chip.
const ATTACH_SCOPE_COPY: Record<AttachScopeMode, { label: string; description: string }> = {
  auto: {
    label: 'Smart',
    description: 'Documents stay available to this notebook; images attach to one message.',
  },
  notebook: {
    label: 'Whole notebook',
    description: 'Everything is kept for this notebook and re-sent with every message.',
  },
  message: {
    label: 'Just this message',
    description: 'Nothing is kept - files attach to one message only.',
  },
};

// Rows styled like the sidebar's Quick Filters (Notebook/Search/QuickFilters.tsx): 32px rows,
// 6px corners, 8px side padding, 12px from icon to label, 4px between rows, and the same hover
// fill - keep the two in sync. Joy paints the hover through its variant vars, not a plain &:hover.
const plusMenuListSx = (mode: 'light' | 'dark') => {
  const hoverBg = mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12];
  return {
    '--List-padding': '0px',
    '--List-gap': '4px',
    '--ListItem-minHeight': '32px',
    '--ListItem-radius': '6px',
    '--ListItem-paddingX': '8px',
    '--ListItem-paddingY': '0px',
    '--ListItemDecorator-size': '30px',
    '& .MuiListItemButton-root': {
      '--variant-plainHoverBg': hoverBg,
      '--variant-plainActiveBg': hoverBg,
      transition: 'background-color 0.15s ease',
    },
    '& .MuiListItemButton-root.Mui-selected': { backgroundColor: hoverBg, color: 'text.primary' },
  };
};

type Submenu = 'briefcase' | 'image' | 'uploadScope';

/**
 * How long a file uploaded from this device stays in the notebook. Only the device upload (and a
 * drop onto the composer) honours it - Drive, the file browser and paste always keep the file.
 * Three-valued, not a switch: "this document, just once" and "this image, keep it" are opposite
 * overrides of the default and a boolean can only express one of them.
 */
const UploadScopeOptions: FC<{ value: AttachScopeMode; onChange: (mode: AttachScopeMode) => void }> = ({
  value,
  onChange,
}) => {
  const theme = useTheme();
  const hoverBg = theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary', px: '8px', pt: '4px', pb: '2px' }}>
        Files uploaded from this device
      </Typography>
      <RadioGroup
        size="sm"
        value={value}
        data-testid="attach-file-scope-radiogroup"
        onChange={event => onChange(event.target.value as AttachScopeMode)}
        sx={{ gap: '4px', m: 0 }}
      >
        {ATTACH_SCOPE_MODES.map(mode => (
          // overlay makes the whole row the radio's hit target; the row is positioned for it.
          <Box
            key={mode}
            sx={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              px: '8px',
              py: '6px',
              borderRadius: '6px',
              transition: 'background-color 0.15s ease',
              '&:hover': { backgroundColor: hoverBg },
            }}
          >
            <Radio
              overlay
              value={mode}
              label={ATTACH_SCOPE_COPY[mode].label}
              data-testid={`attach-file-scope-${mode}-radio`}
              slotProps={{
                input: { 'aria-describedby': `attach-scope-${mode}-desc` },
                // overlay stretches the action over the row, and globals.css frames a checked action
                // with an !important green border - meant for the small radio, it would box the whole
                // row here. The doubled class outranks that rule; the row's own hover is the cue.
                action: {
                  sx: {
                    '&&, &&.Mui-checked': { border: 'none !important', backgroundColor: 'transparent' },
                  },
                },
              }}
              sx={{ '--Radio-gap': '12px', color: 'text.primary' }}
            />
            {/* Lines up under the label: 16px radio + the 12px gap. */}
            <Typography id={`attach-scope-${mode}-desc`} level="body-xs" sx={{ color: 'text.tertiary', pl: '28px' }}>
              {ATTACH_SCOPE_COPY[mode].description}
            </Typography>
          </Box>
        ))}
      </RadioGroup>
    </Box>
  );
};

interface IProps {
  onUploadFromComputer: () => void;
  onAddFromGoogleDrive: (fabFile: IFabFileDocument) => void;
  onAddFromFileBrowser: () => void;
  attachScopeMode: AttachScopeMode;
  onAttachScopeModeChange: (mode: AttachScopeMode) => void;
  totalFilesCount?: number;
  chatInputValue?: string;
  onOptimizePrompt?: () => void;
  /** Agent mode can't change while a turn is being sent. */
  agentModeDisabled?: boolean;
}

const AttachFileButton = ({
  onUploadFromComputer,
  onAddFromGoogleDrive,
  onAddFromFileBrowser,
  attachScopeMode,
  onAttachScopeModeChange,
  totalFilesCount,
  chatInputValue,
  onOptimizePrompt,
  agentModeDisabled = false,
}: IProps) => {
  const theme = useTheme();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: config } = useConfig();
  const { googleClientId } = config || {};
  const [openPicker] = useDrivePicker();

  const currentUser = useUser(state => state.currentUser);
  const [currentView, setCurrentView] = useState<'main' | 'other-apps' | Submenu>('main');

  const [isOpen, setIsOpen] = useState(false);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  // Desktop side panel next to the menu (prompt catalog, image options); phones use currentView.
  // Every close path (outside click, a picked item, a new file landing) drops it too.
  const [flyout, setFlyout] = useState<Submenu | null>(null);
  // Where the upload-settings panel lines up: level with the upload row, not the menu's bottom.
  const uploadRowRef = useRef<HTMLLIElement>(null);
  const [flyoutTop, setFlyoutTop] = useState<number | null>(null);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) setFlyout(null);
  }
  // A file can land while the menu is open without going through one of its items (the native
  // picker, drag and drop), so a new attachment closes the menu instead of leaving it over the composer.
  const [seenFilesCount, setSeenFilesCount] = useState(totalFilesCount);
  if (totalFilesCount !== seenFilesCount) {
    setSeenFilesCount(totalFilesCount);
    if ((totalFilesCount ?? 0) > (seenFilesCount ?? 0)) {
      setIsOpen(false);
      setCurrentView('main');
    }
  }

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

  const isAgentModeFeatureEnabled = isFeatureEnabled('agentMode');
  const isBriefcaseEnabled = isFeatureEnabled('enableBriefcase');
  const agentMode = useLLM(state => state.agentMode);
  const model = useLLM(state => state.model);
  const { setState: setLLM } = useLLM;
  const showDice = tools.includes('dice_roll') && !isToolDenied('dice_roll', currentSession?.disabledTools);
  const showImageOptions = isImageModel(model);

  const closeMenu = () => {
    setIsOpen(false);
    setCurrentView('main');
    setFlyout(null);
  };
  const openSubmenu = (panel: Submenu) => {
    if (isMobile) {
      setCurrentView(panel);
      return;
    }
    const row = uploadRowRef.current?.getBoundingClientRect();
    const menu = dropdownRef.current?.getBoundingClientRect();
    setFlyoutTop(panel === 'uploadScope' && row && menu ? row.top - menu.top : null);
    setFlyout(current => (current === panel ? null : panel));
  };
  const uploadScopeOpen = flyout === 'uploadScope' || currentView === 'uploadScope';

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
            queryClient.setQueriesData({ queryKey: fabFileKeys.all }, (oldData: any) => {
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
      <Tooltip title="Add files and more" placement="top">
        <IconButton
          data-testid="attach-files-btn"
          ref={buttonRef}
          variant="outlined"
          color="neutral"
          size="sm"
          onClick={() => (isOpen ? closeMenu() : setIsOpen(true))}
          sx={{ zIndex: 100 }}
        >
          <AddIcon sx={{ fontSize: isMobile ? 16 : 20 }} />
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
            p: '8px',
          }}
        >
          <List sx={plusMenuListSx(theme.palette.mode)}>
            {currentView === 'main' ? (
              <>
                {/* Always shown, dimmed like the sidebar's row menu icon (SidenavItem) and full strength
                    on hover or while its panel is open. */}
                <ListItem
                  ref={uploadRowRef}
                  sx={{ p: 0 }}
                  endAction={
                    <IconButton
                      data-testid="upload-scope-settings-btn"
                      aria-label="Upload settings"
                      aria-expanded={uploadScopeOpen}
                      size="sm"
                      variant="plain"
                      color="neutral"
                      onClick={() => openSubmenu('uploadScope')}
                      sx={{
                        '--IconButton-size': '28px',
                        '@media (pointer: coarse)': { '--IconButton-size': '44px' },
                        '& .MuiSvgIcon-root': {
                          opacity: uploadScopeOpen ? 1 : 0.5,
                          transition: 'opacity 0.3s ease',
                        },
                        '&:hover, &:focus-visible': {
                          backgroundColor: 'transparent',
                          '& .MuiSvgIcon-root': { opacity: 1 },
                        },
                      }}
                    >
                      <SettingsOutlinedIcon sx={{ fontSize: '16px' }} />
                    </IconButton>
                  }
                >
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

                {/* Open the Knowledge Base (Knowledge Viewer) for the current session.
                    Previously the only way in was the "Open in Knowledge Viewer" button on
                    an artifact card - this surfaces it directly so users can browse session
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

                {(isAgentModeFeatureEnabled || isResearchModeFeatureEnabled) && <ListDivider />}

                {/* Agent mode moved here from the composer row; the menu stays open so the switch
                    can be read back. */}
                {isAgentModeFeatureEnabled && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      data-testid="attach-menu-agent-mode-btn"
                      aria-pressed={agentMode.enabled}
                      disabled={agentModeDisabled}
                      onClick={() => setLLM({ agentMode: { enabled: !agentMode.enabled, source: 'toggle' } })}
                      sx={{ color: 'text.primary', m: 0 }}
                    >
                      <ListItemDecorator>
                        <BoltIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Agent mode
                      <Switch
                        size="sm"
                        checked={agentMode.enabled}
                        sx={{ ml: 'auto', pointerEvents: 'none' }}
                        slotProps={{ input: { tabIndex: -1, 'aria-hidden': true } }}
                      />
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

                {(isMobile || isBriefcaseEnabled || showDice || showImageOptions) && <ListDivider />}

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

                {isBriefcaseEnabled && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      data-testid="attach-menu-prompt-catalog-btn"
                      selected={flyout === 'briefcase'}
                      onClick={() => openSubmenu('briefcase')}
                      sx={{ color: 'text.primary', m: 0 }}
                    >
                      <ListItemDecorator>
                        <BriefcaseIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Prompt catalog
                      <ChevronRightIcon sx={{ ml: 'auto', fontSize: '18px', color: 'text.tertiary' }} />
                    </ListItemButton>
                  </ListItem>
                )}

                {showDice && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      data-testid="attach-menu-roll-dice-btn"
                      onClick={() => {
                        closeMenu();
                        rollRandomDice();
                      }}
                      sx={{ color: 'text.primary', m: 0 }}
                    >
                      <ListItemDecorator>
                        <CasinoIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Roll Dice
                    </ListItemButton>
                  </ListItem>
                )}
                {showImageOptions && (
                  <ListItem sx={{ p: 0 }}>
                    <ListItemButton
                      data-testid="attach-menu-image-options-btn"
                      selected={flyout === 'image'}
                      onClick={() => openSubmenu('image')}
                      sx={{ color: 'text.primary', m: 0 }}
                    >
                      <ListItemDecorator>
                        <ImageOutlinedIcon sx={{ color: 'text.primary50', fontSize: '18px' }} />
                      </ListItemDecorator>
                      Image options
                      <ChevronRightIcon sx={{ ml: 'auto', fontSize: '18px', color: 'text.tertiary' }} />
                    </ListItemButton>
                  </ListItem>
                )}
              </>
            ) : currentView === 'briefcase' || currentView === 'image' || currentView === 'uploadScope' ? (
              <>
                {/* Phones have no room for a side panel, so a submenu replaces the list. */}
                <ListItem sx={{ p: 0 }}>
                  <ListItemButton
                    onClick={() => setCurrentView('main')}
                    sx={{ color: 'text.primary', borderBottom: '1px solid', borderColor: 'divider', mb: 0.5 }}
                  >
                    <ListItemDecorator>
                      <ArrowBack sx={{ color: 'text.primary50', fontSize: '18px' }} />
                    </ListItemDecorator>
                    Back
                  </ListItemButton>
                </ListItem>
                {currentView === 'briefcase' ? (
                  <BriefcasePanel onLaunched={closeMenu} />
                ) : currentView === 'image' ? (
                  <ImageOptionsPanel onOpenPromptBuilder={closeMenu} />
                ) : (
                  <UploadScopeOptions value={attachScopeMode} onChange={onAttachScopeModeChange} />
                )}
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
          </List>

          {!isMobile && flyout && (
            <Box
              data-testid="attach-menu-flyout"
              sx={{
                position: 'absolute',
                left: 'calc(100% + 4px)',
                ...(flyoutTop !== null ? { top: flyoutTop } : { bottom: 0 }),
                width: flyout === 'uploadScope' ? '300px' : '340px',
                maxHeight: '480px',
                overflow: 'auto',
                backgroundColor: 'background.surface',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 'sm',
                boxShadow: 'md',
                p: '8px',
              }}
            >
              {flyout === 'briefcase' ? (
                <BriefcasePanel onLaunched={closeMenu} />
              ) : flyout === 'image' ? (
                <ImageOptionsPanel onOpenPromptBuilder={closeMenu} />
              ) : (
                <UploadScopeOptions value={attachScopeMode} onChange={onAttachScopeModeChange} />
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
export default AttachFileButton;

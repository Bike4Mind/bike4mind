import { useUser } from '@client/app/contexts/UserContext';
import {
  useAutoRenameSession,
  useCloneSession,
  useCopySessionAsMarkdown,
  useDeleteSession,
  useDownloadSession,
  useExportSessionToExcel,
  useExportSessionToWord,
  useSendSessionToDataLake,
  useSummarizeSession,
  useToggleFavoriteSession,
  useUpdateSessionTags,
} from '@client/app/hooks/data/sessions';
import { useJobStatus } from '@client/app/hooks/useJobStatus';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { ISessionDocument, ISessionFavoriteItem, InviteType } from '@bike4mind/common';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import GridOnIcon from '@mui/icons-material/GridOn';
import ArticleIcon from '@mui/icons-material/Article';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import MagnifyingGlassIcon from '@mui/icons-material/ManageSearch';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import GearIcon from '@mui/icons-material/Settings';
import TagIcon from '@mui/icons-material/Style';
import SendIcon from '@mui/icons-material/Send';
import StorageIcon from '@mui/icons-material/Storage';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/joy';
import { FC, memo, useRef, useState, useCallback, useMemo, useEffect } from 'react';

import SessionMetadataModal from '@client/app/components/common/SessionMetadataModal';
import ShareDocumentModal from '@client/app/components/common/ShareModal';
import SessionRenameInput from '@client/app/components/Session/RenameInput';
import { userCanDeleteDoc, userCanShareDoc, userCanUpdateDoc } from '@client/app/utils/userPermission';
import clsx from 'clsx';
import { useNavigate } from '@tanstack/react-router';
import { useSessions } from '@client/app/contexts/SessionsContext';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useProjectAddToModal } from '@client/app/components/Project/ProjectAddToModal';
import FolderPlusIcon from '@mui/icons-material/CreateNewFolder';
import { useTranslation } from 'react-i18next';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import useToggle from '@client/app/hooks/useToggle';
import NotebookCurationModal from '@client/app/components/ProfileModal/NotebookCurationModal';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { useTriggerProactiveMessages } from '@client/app/hooks/data/agentProactiveMessaging';
import { useSessionUnreadCount } from '@client/app/hooks/useUnreadProactiveMessages';
import { green, greenAlpha } from '@client/app/utils/themes/colors';

/**
 * Classify message count into two tiers:
 * 'light' = 0-10 messages (neutral/subtle)
 * 'substantial' = 10+ messages (green/highlighted)
 */
const getMessageCountTier = (count: number | undefined | null): 'light' | 'substantial' => {
  if (count === undefined || count === null || count <= 10) return 'light';
  return 'substantial';
};

const SessionSidenavItem: FC<{
  session: ISessionDocument;
  onClick?: () => void;
  location?: 'header';
  favoriteSessions?: ISessionFavoriteItem[];
  isEditMode?: boolean;
  isChecked?: boolean;
  onToggleSelection?: () => void;
  isShared?: boolean;
  showMessageCount?: boolean;
  /** Override the rendered name (e.g. /opti shows still-default-named sessions as
   *  "New conversation"). Falsy values fall back to the formatted session name. */
  displayNameOverride?: string;
  /** Explicit selected state. When provided, drives the row highlight instead of the default
   *  `currentSessionId === session.id` comparison. Surfaces that track their active notebook
   *  outside SessionsContext (e.g. /opti, whose docked session lives in the `?session=` URL,
   *  not `currentSessionId`) pass this so the highlight matches the open chat rather than a
   *  stale/foreign context value. Omit it to keep the default context-driven behavior. */
  selected?: boolean;
}> = ({
  session,
  onClick,
  location,
  favoriteSessions = [],
  isEditMode = false,
  isChecked = false,
  onToggleSelection,
  isShared = false,
  showMessageCount = true,
  displayNameOverride,
  selected,
}): React.JSX.Element => {
  const { currentSessionId } = useSessions();
  const { currentUser, isAdmin } = useUser();
  const [openShareModal, setOpenShareModal] = useState(false);
  const [openSessionModal, setOpenSessionModal] = useState(false);
  const [openNotebookCurationModal, toggleNotebookCurationModal] = useToggle();
  const { openModal } = useProjectAddToModal();
  const cloneSession = useCloneSession();
  const copySessionAsMarkdown = useCopySessionAsMarkdown();
  const downloadSession = useDownloadSession();
  const exportToExcel = useExportSessionToExcel();
  const exportToWord = useExportSessionToWord();
  const sendToDataLake = useSendSessionToDataLake();
  const { isFeatureEnabled } = useAdminSettingsCache();
  const summarizeSession = useSummarizeSession();
  const toggleFavoriteSession = useToggleFavoriteSession(session.id);
  const updateSessionTags = useUpdateSessionTags();
  const autoRename = useAutoRenameSession();
  const deleteSession = useDeleteSession();
  const triggerProactiveMessages = useTriggerProactiveMessages();
  const textRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isTextTruncated, setIsTextTruncated] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const isFavorite = useMemo(
    () => favoriteSessions.some(favSession => favSession.id === session.id),
    [favoriteSessions, session.id]
  );

  // Get unread proactive message count for this session
  const unreadCount = useSessionUnreadCount(session.id);

  const { isJobRunning, getRunningJobs } = useJobStatus();
  const isProcessingJobs = isJobRunning(session.id);
  const runningJobTypes = getRunningJobs(session.id);

  // Existing sessions may have a raw JSON literal as their name. Format it for
  // display so the sidebar (and the derived accessible name) stays readable.
  const displayName = useMemo(
    () => displayNameOverride || formatSessionTitle(session.name),
    [displayNameOverride, session.name]
  );

  // The real underlying title - used to pre-fill the rename input so the user edits what's
  // actually stored, never the synthetic display override (e.g. /opti's "New conversation",
  // which would otherwise be persisted verbatim on a blind Enter). Matches displayName for
  // every caller that doesn't pass an override.
  const editableName = useMemo(() => formatSessionTitle(session.name), [session.name]);

  const canShare = useMemo(() => userCanShareDoc(currentUser, session), [currentUser, session]);
  const canUpdate = useMemo(() => userCanUpdateDoc(currentUser, session), [currentUser, session]);
  const canDelete = useMemo(() => userCanDeleteDoc(currentUser, session), [currentUser, session]);

  const isProcessing =
    downloadSession.isPending ||
    cloneSession.isPending ||
    summarizeSession.isPending ||
    updateSessionTags.isPending ||
    deleteSession.isPending ||
    isProcessingJobs; // Include background job status

  // An explicit `selected` prop wins over the context comparison so surfaces whose active
  // notebook isn't tracked in SessionsContext (e.g. /opti's docked `?session=`) can highlight
  // the row that's actually open. `?? ` (not `||`) means only an omitted prop falls through -
  // a deliberate `selected={false}` keeps the row unhighlighted rather than reviving the
  // stale context match.
  const isSelected = selected ?? currentSessionId === session.id;

  // Check if text is truncated to determine if tooltip should be shown
  useEffect(() => {
    const checkTextTruncation = () => {
      if (textRef.current) {
        const element = textRef.current;
        setIsTextTruncated(element.scrollWidth > element.clientWidth);
      }
    };

    checkTextTruncation();

    // Check on window resize as well
    window.addEventListener('resize', checkTextTruncation);
    return () => window.removeEventListener('resize', checkTextTruncation);
  }, [displayName]);

  const handleShareClick = useCallback(() => {
    setOpenShareModal(true);
  }, []);

  const handleOpenSessionModal = useCallback(() => {
    setOpenSessionModal(true);
  }, []);

  const handleCloneSession = useCallback(() => {
    cloneSession.mutate(session.id);
  }, [cloneSession, session.id]);

  const handleDownloadSession = useCallback(() => {
    downloadSession.mutate(session);
  }, [downloadSession, session]);

  const handleExportToExcel = useCallback(() => {
    exportToExcel.mutate(session);
  }, [exportToExcel, session]);

  const handleExportToWord = useCallback(() => {
    exportToWord.mutate(session);
  }, [exportToWord, session]);

  const handleCopyAsMarkdown = useCallback(() => {
    copySessionAsMarkdown.mutate(session);
  }, [copySessionAsMarkdown, session]);

  const handleSendToDataLake = useCallback(() => {
    sendToDataLake.mutate(session);
  }, [sendToDataLake, session]);

  const handleSummarizeSession = useCallback(() => {
    summarizeSession.mutate(session.id);
  }, [summarizeSession, session.id]);

  const handleToggleFavoriteSession = useCallback(async () => {
    try {
      await toggleFavoriteSession.mutateAsync();
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  }, [toggleFavoriteSession]);

  const handleUpdateSessionTags = useCallback(() => {
    updateSessionTags.mutate(session.id);
  }, [updateSessionTags, session.id]);

  const handleAddProjectModalOpen = useCallback(() => {
    openModal(session.id, 'session');
  }, [openModal, session.id]);

  const handleOpenCurateModal = useCallback(() => {
    toggleNotebookCurationModal();
  }, [toggleNotebookCurationModal]);

  const handleTriggerProactiveMessages = useCallback(() => {
    triggerProactiveMessages.mutate(session.id);
  }, [triggerProactiveMessages, session.id]);

  const handleOpenDeleteModal = useCallback(() => {
    setOpenDeleteModal(true);
  }, []);

  const handleRename = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleRenameSuccess = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleDeleteSessionConfirm = useCallback(async () => {
    const { newLastNotebookId, deletedNotebookId } = await deleteSession.mutateAsync(session.id);
    if (!newLastNotebookId) {
      navigate({ to: '/new' });
    } else if (deletedNotebookId === currentSessionId) {
      navigate({ to: `/notebooks/${newLastNotebookId}` });
    }
    setOpenDeleteModal(false);
  }, [deleteSession, session.id, navigate, currentSessionId]);

  const handleDeleteSessionCancel = useCallback(() => {
    setOpenDeleteModal(false);
  }, []);

  const handleCloseSessionModal = useCallback(() => {
    setOpenSessionModal(false);
  }, []);

  const ShareModal = useMemo(
    () =>
      openShareModal ? (
        <ShareDocumentModal
          onClose={() => setOpenShareModal(false)}
          open={openShareModal}
          id={session.id}
          name={formatSessionTitle(session.name)}
          type={InviteType.Session}
          users={session.users}
        />
      ) : null,
    [openShareModal, session.id, session.name, session.users]
  );

  const boxStyles = useMemo(
    () => (theme: any) => ({
      borderRadius: '5px',
      cursor: 'pointer',
      backgroundColor: isSelected ? theme.palette.notebooklist.focusedBackground : 'transparent',
      position: 'relative',
      // Add left border indicator for active state
      '&::before': isSelected
        ? {
            content: '""',
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: '3px',
            height: '70%',
            backgroundColor: theme.palette.primary[500],
            borderRadius: '0 2px 2px 0',
          }
        : {},
      '&:hover': {
        backgroundColor: isSelected ? undefined : theme.palette.notebooklist.hoverBg,
        '& .item-actions:not(.isProcessing)': {
          visibility: 'visible',
          opacity: 1,
        },
      },
      '& .item-actions:not(.isProcessing)': {
        visibility: isSelected ? 'visible' : 'hidden',
        opacity: isSelected ? 1 : 0,
      },
      // Header style
      ...(location === 'header' && {
        backgroundColor: 'transparent',
        display: 'flex',
        '&::before': {},
        '&:hover': {
          backgroundColor: 'transparent',
        },
      }),
    }),
    [isSelected, location]
  );

  return (
    <>
      <Box position="relative" sx={boxStyles}>
        {isEditing ? (
          <SessionRenameInput
            data-testid="sidenav-item-rename-input"
            session={session}
            initialValue={editableName}
            size="sm"
            sx={{ mx: '1em' }}
            id="sessionNameEdit"
            variant="plain"
            type="text"
            onSuccess={handleRenameSuccess}
          />
        ) : location === 'header' ? (
          /* Header mode: name, chip, and dropdown arrow all in one unified container */
          <Dropdown>
            <Badge
              color="danger"
              size="sm"
              invisible={unreadCount === 0}
              sx={{
                flex: 1,
                minWidth: 0,
                '& .MuiBadge-badge': {
                  right: 8,
                  top: 8,
                },
              }}
            >
              <Tooltip sx={{ zIndex: 10001 }} title={isTextTruncated ? displayName : ''} followCursor>
                <MenuButton
                  data-testid="sidenav-item-menu-btn"
                  slots={{ root: Button }}
                  variant="plain"
                  sx={{
                    justifyContent: 'flex-start',
                    padding: '0',
                    background: 'transparent',
                    minHeight: '32px',
                    '&:hover': {
                      background: 'transparent',
                    },
                    gap: '6px',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <Typography
                    ref={textRef}
                    level="body-xs"
                    sx={theme => ({
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      color: theme.palette.neutral.softColor,
                      fontWeight: 500,
                      fontSize: '14px',
                      minWidth: 0,
                    })}
                  >
                    {displayName}
                  </Typography>
                  {showMessageCount && (
                    <Chip
                      size="sm"
                      variant="soft"
                      sx={theme => {
                        const base = theme.palette.background.surface2;
                        const isLight = getMessageCountTier(session.messageCount) === 'light';
                        const tint = isLight
                          ? theme.palette.fileBrowser.statusChip.backgroundColor
                          : theme.palette.mode === 'dark'
                            ? greenAlpha[800][20]
                            : greenAlpha[800][20];
                        return {
                          height: '20px',
                          fontSize: '12px',
                          fontWeight: 500,
                          flexShrink: 0,
                          minWidth: 'auto',
                          '& .MuiChip-label': { px: '2px' },
                          background: `linear-gradient(${tint}, ${tint}), linear-gradient(${base}, ${base})`,
                          color: isLight
                            ? theme.palette.fileBrowser.statusChip.textColor
                            : theme.palette.mode === 'dark'
                              ? theme.palette.text.primary
                              : green[800],
                          border: isLight
                            ? `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`
                            : `1px solid ${green[800]}`,
                        };
                      }}
                    >
                      {session.messageCount !== undefined && session.messageCount !== null ? session.messageCount : '?'}
                    </Chip>
                  )}
                  <KeyboardArrowDownIcon sx={{ fontSize: 16, flexShrink: 0, opacity: 0.6 }} />
                </MenuButton>
              </Tooltip>
            </Badge>
            <Menu
              className="menuSurface"
              sx={{
                zIndex: 1400,
                borderRadius: '10px',
              }}
              variant={'outlined'}
              placement="bottom-start"
              direction="ltr"
            >
              {canUpdate && (
                <MenuItem onClick={handleToggleFavoriteSession} className="sidenav-item-menuitem-favorite">
                  {isFavorite ? (
                    <>
                      <FavoriteIcon color="primary" /> {t('llm.unfavorite')}
                    </>
                  ) : (
                    <>
                      <FavoriteBorderIcon /> {t('llm.favorite')}
                    </>
                  )}
                </MenuItem>
              )}
              <MenuItem
                id="add-project"
                onClick={handleAddProjectModalOpen}
                className="sidenav-item-menuitem-addproject"
              >
                <FolderPlusIcon /> {t('projects.add_to_project')}
              </MenuItem>
              {canShare && (
                <MenuItem onClick={handleShareClick} className="sidenav-item-menuitem-share">
                  <CompareArrowsIcon /> {t('share')}
                </MenuItem>
              )}
              <Divider sx={{ my: 1 }} />
              {canUpdate && (
                <>
                  <MenuItem
                    onClick={handleRename}
                    className="sidenav-item-menuitem-rename"
                    data-testid="sidenav-item-menuitem-rename"
                  >
                    {isEditing ? <CloseIcon /> : <EditIcon />} {t('rename')}
                  </MenuItem>
                  <MenuItem onClick={() => autoRename.mutate(session.id)} className="sidenav-item-menuitem-autorename">
                    <AutoAwesomeOutlinedIcon /> {t('notebooks.auto_rename')}
                  </MenuItem>
                </>
              )}
              <MenuItem onClick={handleCloneSession} className="sidenav-item-menuitem-clone">
                <FolderCopyIcon /> {t('notebooks.clone')}
              </MenuItem>
              <MenuItem onClick={handleDownloadSession} className="sidenav-item-menuitem-download">
                <DownloadIcon /> {t('notebooks.download')}
              </MenuItem>
              <MenuItem onClick={handleCopyAsMarkdown} className="sidenav-item-menuitem-copy-markdown">
                <ContentCopyIcon /> Copy as Markdown
              </MenuItem>
              <Divider sx={{ my: 1 }} />
              <MenuItem
                onClick={handleExportToExcel}
                className="sidenav-item-menuitem-export-excel"
                data-testid="sidenav-item-menuitem-export-excel"
                disabled={exportToExcel.isPending}
              >
                <GridOnIcon /> Export to Excel
              </MenuItem>
              <MenuItem
                onClick={handleExportToWord}
                className="sidenav-item-menuitem-export-word"
                data-testid="sidenav-item-menuitem-export-word"
                disabled={exportToWord.isPending}
              >
                <ArticleIcon /> Export to Word
              </MenuItem>
              {isFeatureEnabled('EnableDataLakes') && (
                <MenuItem
                  onClick={handleSendToDataLake}
                  className="sidenav-item-menuitem-send-datalake"
                  data-testid="sidenav-item-menuitem-send-datalake"
                  disabled={sendToDataLake.isPending}
                >
                  <StorageIcon /> Send to Data Lake
                </MenuItem>
              )}
              {canUpdate && (
                <>
                  <MenuItem onClick={handleSummarizeSession} className="sidenav-item-menuitem-summarize">
                    <GearIcon /> {t('notebooks.summarize')}
                  </MenuItem>
                  <MenuItem onClick={handleUpdateSessionTags} className="sidenav-item-menuitem-tags">
                    <TagIcon /> {t('sidenav.sessions.item.genTags')}
                  </MenuItem>
                  <MenuItem
                    onClick={handleOpenCurateModal}
                    className="sidenav-item-menuitem-curate"
                    data-testid="sidenav-item-menuitem-curate"
                  >
                    <MenuBookIcon /> Curate
                  </MenuItem>
                  {isAdmin && (
                    <MenuItem
                      onClick={handleTriggerProactiveMessages}
                      className="sidenav-item-menuitem-trigger-proactive"
                      data-testid="sidenav-item-menuitem-trigger-proactive"
                      disabled={triggerProactiveMessages.isPending}
                    >
                      <SendIcon /> Test Proactive Messages
                    </MenuItem>
                  )}
                </>
              )}
              <MenuItem
                onClick={handleOpenSessionModal}
                className="sidenav-item-menuitem-viewinfo"
                data-testid="sidenav-item-menuitem-viewinfo"
              >
                <MagnifyingGlassIcon /> {t('notebooks.view_info')}
              </MenuItem>
              <Divider sx={{ my: 1 }} />
              {canDelete && (
                <MenuItem
                  onClick={handleOpenDeleteModal}
                  color="danger"
                  className="sidenav-item-menuitem-delete"
                  data-testid="sidenav-item-menuitem-delete"
                >
                  <DeleteOutline />
                  {t('notebooks.delete')}
                </MenuItem>
              )}
            </Menu>
            {openSessionModal && <SessionMetadataModal session={session} onClose={handleCloseSessionModal} />}
            {ShareModal}
          </Dropdown>
        ) : (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              gap: '12px',
            }}
          >
            {isEditMode && (
              <Checkbox
                data-testid="sidenav-item-checkbox"
                checked={isChecked}
                onChange={onToggleSelection}
                size="sm"
                sx={{
                  flexShrink: 0,
                  ml: '8px',
                }}
              />
            )}
            <Badge
              color="danger"
              size="sm"
              invisible={unreadCount === 0}
              sx={{
                flex: 1,
                minWidth: 0,
                '& .MuiBadge-badge': {
                  right: 8,
                  top: 8,
                },
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  minWidth: 0,
                  pr: '36px',
                }}
              >
                <Tooltip sx={{ zIndex: 10001 }} title={isTextTruncated ? displayName : ''} followCursor>
                  <Button
                    data-testid="sidenav-item-session-btn"
                    sx={{
                      justifyContent: 'flex-start',
                      padding: isEditMode ? '0px' : '6px 12px',
                      paddingRight: isEditMode ? '0px' : '4px',
                      background: 'transparent',
                      minHeight: '36px',
                      '&:hover': {
                        background: 'transparent',
                      },
                      gap: '12px',
                      minWidth: 0,
                      maxWidth: '100%',
                      width: '100%',
                      flex: '1 1 auto',
                    }}
                    onClick={isEditMode ? onToggleSelection : onClick}
                    variant="plain"
                  >
                    {isShared && (
                      <Tooltip title="Shared with you" placement="top">
                        <Box
                          sx={theme => ({
                            width: '20px',
                            height: '20px',
                            borderRadius: '4px',
                            backgroundColor:
                              theme.palette.mode === 'dark' ? 'rgba(209, 228, 244, 0.1)' : 'rgba(209, 228, 244, 0.7)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          })}
                        >
                          <CompareArrowsIcon
                            sx={theme => ({
                              fontSize: '14px',
                              color: theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70',
                            })}
                          />
                        </Box>
                      </Tooltip>
                    )}
                    <Typography
                      ref={textRef}
                      level="body-xs"
                      sx={theme => ({
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: theme.palette.neutral.softColor,
                        fontWeight: 400,
                      })}
                    >
                      {displayName}
                    </Typography>
                  </Button>
                </Tooltip>
                {showMessageCount && (
                  <Chip
                    size="sm"
                    variant="soft"
                    sx={theme => {
                      const base = theme.palette.background.surface2;
                      const isLight = getMessageCountTier(session.messageCount) === 'light';
                      const tint = isLight
                        ? theme.palette.fileBrowser.statusChip.backgroundColor
                        : theme.palette.mode === 'dark'
                          ? greenAlpha[800][20]
                          : greenAlpha[800][20];
                      return {
                        height: '20px',
                        fontSize: '12px',
                        fontWeight: 500,
                        flexShrink: 0,
                        minWidth: 'auto',
                        '& .MuiChip-label': { px: '2px' },
                        background: `linear-gradient(${tint}, ${tint}), linear-gradient(${base}, ${base})`,
                        color: isLight
                          ? theme.palette.fileBrowser.statusChip.textColor
                          : theme.palette.mode === 'dark'
                            ? theme.palette.text.primary
                            : green[800],
                        border: isLight
                          ? `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`
                          : `1.5px solid ${green[800]}`,
                      };
                    }}
                  >
                    {session.messageCount !== undefined && session.messageCount !== null ? session.messageCount : '?'}
                  </Chip>
                )}
              </Box>
            </Badge>
          </Box>
        )}
        {/* Hide menu button in edit mode to focus on selection actions - sidenav only */}
        {!isEditMode && location !== 'header' && (
          <Box
            sx={{
              position: 'absolute',
              right: '0',
              top: '0',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              backgroundColor: 'success.main',
              color: 'success.contrastText',
              fontSize: '12px',
            }}
          >
            <Dropdown>
              <MenuButton
                data-testid="sidenav-item-menu-btn"
                size={'sm'}
                slots={{ root: IconButton }}
                className={clsx('item-actions', { isProcessing })}
                sx={{
                  visibility: isProcessing ? 'visible' : 'hidden',
                  opacity: isProcessing ? 1 : 0,
                  transition: 'visibility 0s, opacity 0.5s ease',
                  '& .MuiSvgIcon-root': {
                    opacity: 0.5,
                    transition: 'opacity 0.3s ease',
                  },
                  '&:hover, &:focus, &:active': {
                    backgroundColor: 'transparent',
                    '& .MuiSvgIcon-root': {
                      opacity: 1,
                    },
                  },
                }}
              >
                {isProcessing ? (
                  <Tooltip
                    title={
                      runningJobTypes.length > 0
                        ? `Running: ${runningJobTypes.map(jobType => (jobType === 'generateTags' ? 'Tags' : 'Summary')).join(', ')}`
                        : 'Processing...'
                    }
                  >
                    <CircularProgress size="sm" />
                  </Tooltip>
                ) : (
                  <MoreVertIcon />
                )}
              </MenuButton>

              <Menu
                className="menuSurface"
                sx={{
                  zIndex: 1400,
                  borderRadius: '10px',
                }}
                variant={'outlined'}
                placement="right-start"
                direction="ltr"
              >
                {canUpdate && (
                  <MenuItem onClick={handleToggleFavoriteSession} className="sidenav-item-menuitem-favorite">
                    {isFavorite ? (
                      <>
                        <FavoriteIcon color="primary" /> {t('llm.unfavorite')}
                      </>
                    ) : (
                      <>
                        <FavoriteBorderIcon /> {t('llm.favorite')}
                      </>
                    )}
                  </MenuItem>
                )}
                <MenuItem
                  id="add-project"
                  onClick={handleAddProjectModalOpen}
                  className="sidenav-item-menuitem-addproject"
                >
                  <FolderPlusIcon /> {t('projects.add_to_project')}
                </MenuItem>
                {canShare && (
                  <MenuItem onClick={handleShareClick} className="sidenav-item-menuitem-share">
                    <CompareArrowsIcon /> {t('share')}
                  </MenuItem>
                )}
                <Divider sx={{ my: 1 }} />
                {canUpdate && (
                  <>
                    <MenuItem
                      onClick={handleRename}
                      className="sidenav-item-menuitem-rename"
                      data-testid="sidenav-item-menuitem-rename"
                    >
                      {isEditing ? <CloseIcon /> : <EditIcon />} {t('rename')}
                    </MenuItem>
                    <MenuItem
                      onClick={() => autoRename.mutate(session.id)}
                      className="sidenav-item-menuitem-autorename"
                    >
                      <AutoAwesomeOutlinedIcon /> {t('notebooks.auto_rename')}
                    </MenuItem>
                  </>
                )}
                <MenuItem onClick={handleCloneSession} className="sidenav-item-menuitem-clone">
                  <FolderCopyIcon /> {t('notebooks.clone')}
                </MenuItem>
                <MenuItem onClick={handleDownloadSession} className="sidenav-item-menuitem-download">
                  <DownloadIcon /> {t('notebooks.download')}
                </MenuItem>
                <MenuItem onClick={handleCopyAsMarkdown} className="sidenav-item-menuitem-copy-markdown">
                  <ContentCopyIcon /> Copy as Markdown
                </MenuItem>
                <Divider sx={{ my: 1 }} />
                <MenuItem
                  onClick={handleExportToExcel}
                  className="sidenav-item-menuitem-export-excel"
                  data-testid="sidenav-item-menuitem-export-excel"
                  disabled={exportToExcel.isPending}
                >
                  <GridOnIcon /> Export to Excel
                </MenuItem>
                <MenuItem
                  onClick={handleExportToWord}
                  className="sidenav-item-menuitem-export-word"
                  data-testid="sidenav-item-menuitem-export-word"
                  disabled={exportToWord.isPending}
                >
                  <ArticleIcon /> Export to Word
                </MenuItem>
                {isFeatureEnabled('EnableDataLakes') && (
                  <MenuItem
                    onClick={handleSendToDataLake}
                    className="sidenav-item-menuitem-send-datalake"
                    data-testid="sidenav-item-menuitem-send-datalake"
                    disabled={sendToDataLake.isPending}
                  >
                    <StorageIcon /> Send to Data Lake
                  </MenuItem>
                )}
                {canUpdate && (
                  <>
                    <MenuItem onClick={handleSummarizeSession} className="sidenav-item-menuitem-summarize">
                      <GearIcon /> {t('notebooks.summarize')}
                    </MenuItem>
                    <MenuItem onClick={handleUpdateSessionTags} className="sidenav-item-menuitem-tags">
                      <TagIcon /> {t('sidenav.sessions.item.genTags')}
                    </MenuItem>
                    <MenuItem
                      onClick={handleOpenCurateModal}
                      className="sidenav-item-menuitem-curate"
                      data-testid="sidenav-item-menuitem-curate"
                    >
                      <MenuBookIcon /> Curate
                    </MenuItem>
                    {isAdmin && (
                      <MenuItem
                        onClick={handleTriggerProactiveMessages}
                        className="sidenav-item-menuitem-trigger-proactive"
                        data-testid="sidenav-item-menuitem-trigger-proactive"
                        disabled={triggerProactiveMessages.isPending}
                      >
                        <SendIcon /> Test Proactive Messages
                      </MenuItem>
                    )}
                  </>
                )}
                <MenuItem
                  onClick={handleOpenSessionModal}
                  className="sidenav-item-menuitem-viewinfo"
                  data-testid="sidenav-item-menuitem-viewinfo"
                >
                  <MagnifyingGlassIcon /> {t('notebooks.view_info')}
                </MenuItem>
                <Divider sx={{ my: 1 }} />
                {canDelete && (
                  <MenuItem
                    onClick={handleOpenDeleteModal}
                    color="danger"
                    className="sidenav-item-menuitem-delete"
                    data-testid="sidenav-item-menuitem-delete"
                  >
                    <DeleteOutline />
                    {t('notebooks.delete')}
                  </MenuItem>
                )}
              </Menu>
            </Dropdown>

            {openSessionModal && <SessionMetadataModal session={session} onClose={handleCloseSessionModal} />}
            {ShareModal}
          </Box>
        )}
      </Box>
      <ConfirmActionModal
        data-testid="confirm-delete-modal"
        open={openDeleteModal}
        title={t('notebooks.delete')}
        description={t('notebooks.delete_confirm', { name: displayName })}
        onGoForward={handleDeleteSessionConfirm}
        onGoBackward={handleDeleteSessionCancel}
        forwardButtonText="Delete"
        backwardButtonText="Cancel"
        loading={deleteSession.isPending}
      />
      {openNotebookCurationModal && (
        <NotebookCurationModal
          open={openNotebookCurationModal}
          onClose={toggleNotebookCurationModal}
          preSelectedSessionIds={[session.id]}
        />
      )}
    </>
  );
};

// Memoized: rendered once per notebook in the sidebar list (potentially thousands of rows).
// Skips re-render when its props are referentially equal - see NotebookRow in CombinedNotebooks.
export default memo(SessionSidenavItem);

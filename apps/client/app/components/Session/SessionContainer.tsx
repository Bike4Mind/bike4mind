'use client';

import { Box, Button, Modal, ModalDialog, Typography, Stack } from '@mui/joy';
import ReplyStatus from '@client/app/components/common/ReplyStatus';
import { FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import SessionBottom from './SessionBottom';
import SessionMiddle from './SessionMiddle';
import SessionTop from './SessionTop';
import NotebookSplash from './NotebookSplash';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useNotebookFilepond } from '@client/app/components/Session/NotebookFilepondProvider';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import KnowledgeViewer from '../Knowledge/KnowledgeViewer';
import FloatingChatWindow from './FloatingChatWindow';
import DockedChatPanel from './DockedChatPanel';
import { useGetProject } from '@client/app/hooks/data/projects';
import { useNotebookSearch } from '@client/app/contexts/NotebookSearchContext';
import ResizableSplitter from './ResizableSplitter';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useSearch, useLocation, useNavigate } from '@tanstack/react-router';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useSubscribeToSession, useSubscribeToSessionQuests } from '@client/app/hooks/data/sessions';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { recordSessionActivity } from '@client/app/utils/sessionActivityCleanup';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { useQueryClient } from '@tanstack/react-query';
import { useFileDropZone } from './hooks/useFileDropZone';
import { useSessionCacheMigration } from './hooks/useSessionCacheMigration';
import { ChatCompletionProvider } from '@client/app/contexts/ChatCompletionContext';

/**
 * Decide whether to (re)invoke `changeSession` for the routed session id.
 *
 * Returns true only for a not-yet-loading session that differs from the one in
 * context AND hasn't already been attempted this mount. The `attemptedSessionId`
 * check is the safety net: `changeSession` only advances `contextSessionId` on
 * success, so a failed open (404, network blip, 5xx) would otherwise re-fire on
 * every render - the original 404 retry-loop bug. Exported for unit testing.
 */
export function shouldAttemptSessionOpen(
  currentSessionId: string | undefined,
  contextSessionId: string | null,
  isLoading: boolean,
  attemptedSessionId: string | null
): currentSessionId is string {
  // Type guard: a true result implies `currentSessionId` is a non-empty string,
  // which lets callers use it without a redundant null-check.
  return (
    !isLoading && !!currentSessionId && currentSessionId !== contextSessionId && currentSessionId !== attemptedSessionId
  );
}

interface SessionLayoutProps {
  listClosed?: boolean;
  height?: string;
  currentSessionId?: string;
  isLoading: boolean;
  /** When false, KnowledgeViewer won't auto-hide the layout when no artifacts exist. Useful for /opti where floatingChat layout is managed externally. */
  autoHideOnEmpty?: boolean;
  /** Custom splash to show instead of NotebookSplash when no session is active */
  customSplash?: React.ReactNode;
  /** Opt-in splash shown inside the chat area when the active session has no messages yet. Forwarded to SessionMiddle. */
  emptySessionSplash?: React.ReactNode;
  /** Extra action buttons rendered in the FloatingChatWindow header (before minimize/close) */
  floatingChatHeaderActions?: React.ReactNode;
  /** Called when the server auto-creates a session (e.g. first prompt with no session). Lets parent pages like /opti sync their local session state. */
  onSessionCreated?: (sessionId: string) => void;
}

/**
 * Shown between the user hitting send on /new and the server confirming the session.
 * Mirrors the exact DOM structure of SessionMiddle so the visual transition is seamless:
 * session-middle-container -> session-middle-wrapper -> message-content-stack -> user-prompt + ReplyStatus
 */
const PendingFirstMessage: FC<{ message: string; isFullWidth?: boolean }> = ({ message, isFullWidth = false }) => (
  <Box
    className="session-middle-container"
    sx={{
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      height: '100%',
      scrollBehavior: 'smooth',
      width: '100%',
      flex: 1,
      minHeight: 0,
    }}
  >
    <Box
      className="session-middle-wrapper"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        width: '100%',
        flex: 'none',
        pt: 2,
        maxWidth: isFullWidth ? '100%' : '950px',
        marginX: 'auto',
        position: 'relative',
      }}
    >
      <Stack
        className="message-content-stack"
        sx={{ gap: 2, width: '100%', maxWidth: '100%', px: '20px', overflow: 'visible' }}
      >
        {/* User message — mirrors UserPrompt multi-section layout so bubble is content-width */}
        <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', borderRadius: '8px' }}>
            <Box sx={{ maxWidth: '100%', alignSelf: 'end', borderRadius: '8px' }}>
              <Typography
                className="prompt-content"
                variant="soft"
                level="body-md"
                component="div"
                sx={theme => ({
                  margin: 0,
                  padding: 2,
                  backgroundColor: theme.palette.mode === 'light' ? '#F4F7F9' : 'background.panel',
                  borderRadius: '8px',
                  color: 'text.primary',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowX: 'auto',
                })}
              >
                {message}
              </Typography>
            </Box>
          </Box>
        </Box>

        {/* AI thinking — matches StreamingMessage's ai-loading-status + ReplyStatus */}
        <Box
          data-testid="ai-loading-status"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            justifyContent: 'center',
            mt: 2,
            mb: 1,
          }}
        >
          <ReplyStatus renderSpinnerStatusNull={false} status="Running..." />
        </Box>
      </Stack>
    </Box>
  </Box>
);

/** Full-container blur overlay shown while files are dragged over the chat. */
const DropFilesOverlay: FC = () => (
  <Box
    sx={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme => theme.palette.session.overlayBackground,
      backdropFilter: 'blur(10px)',
      zIndex: 110,
      outline: '2px dashed',
      outlineColor: 'primary',
      outlineOffset: '-10px',
    }}
  >
    <Box sx={{ textAlign: 'center', display: 'flex', gap: '.5rem', zIndex: 110 }}>
      <CloudUploadIcon />
      <span>Drop files here to upload</span>
    </Box>
  </Box>
);

const SessionContainer: FC<SessionLayoutProps> = ({
  listClosed,
  currentSessionId,
  isLoading,
  autoHideOnEmpty,
  customSplash,
  emptySessionSplash,
  floatingChatHeaderActions,
  onSessionCreated,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { changeSession, currentSessionId: contextSessionId, setCurrentSessionId, setCurrentSession } = useSessions();
  const queryClient = useQueryClient();
  const { migrateQuests, migrateSession } = useSessionCacheMigration();
  const pendingFirstMessage = useSessionLayout(s => s.pendingFirstMessage);
  const layout = useSessionLayout(s => s.layout);
  const knowledgeViewerWidth = useSessionLayout(s => s.knowledgeViewerWidth) || 50;
  const filepondRef = useNotebookFilepond();
  const {
    isDraggingOver,
    pastedFile,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleConfirmUpload,
  } = useFileDropZone({ containerRef, filepondRef });
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const knowledgeRef = useRef<HTMLDivElement>(null);
  const { projectId: searchProjectId } = useSearch({ strict: false }) as { projectId?: string };
  const { data: project } = useGetProject(searchProjectId as string);
  const { setShowPinnedOnly } = useNotebookSearch();
  const [isFullWidth, setIsFullWidth] = useState(false);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const { subscribeToAction } = useWebsocket();

  // Stable ref for callback so the effect doesn't re-subscribe on every render
  const onSessionCreatedRef = useRef(onSessionCreated);
  useLayoutEffect(() => {
    onSessionCreatedRef.current = onSessionCreated;
  });

  // Track deferred project invalidation so we can clean up on unmount
  const projectInvalidationTimer = useRef<number | undefined>(undefined);

  // Keep a ref of the current projectId from router search params so the
  // session.created websocket callback always reads the latest value without
  // needing to be in its dependency array.
  const searchProjectIdRef = useRef(searchProjectId);
  useLayoutEffect(() => {
    searchProjectIdRef.current = searchProjectId;
  });

  useEffect(() => {
    const unsubscribe = subscribeToAction('session.created', async message => {
      if (message.action !== 'session.created') return;
      const { action, ...realSession } = message;
      const realId = message.id;

      // Read pendingOptimisticId synchronously from Zustand - this is the exact
      // client-generated tmpId written at send time. Using .getState() avoids the
      // stale-ref bug where contextSessionIdRef might still hold the *previous*
      // session's ID if the user navigated to /new and sent a message before the
      // clearing useEffect had a chance to run.
      const { pendingOptimisticId: tmpId } = useSessionLayout.getState();

      // When pre-navigation was used (tmpId set and different from realId), migrate
      // all cached data from the temporary client-generated ID to the real server ID.
      if (tmpId && tmpId !== realId) {
        migrateQuests(tmpId, realId);
        migrateSession(tmpId, realId, realSession);
      }

      setCurrentSessionId(realId);
      setCurrentSession(realSession);

      // Notify parent (e.g. /opti) so it can sync its local session state.
      if (onSessionCreatedRef.current) {
        onSessionCreatedRef.current(realId);
      }

      // Navigate to the real session ID with replace:true so the temporary ID
      // never lands in the browser history stack. Only navigate when we were in
      // the optimistic pending state (tmpId was set) or still on /new.
      if (tmpId || location.pathname === '/new') {
        const currentProjectId = searchProjectIdRef.current;
        await navigate({
          to: '/notebooks/$id',
          params: { id: realId },
          search: currentProjectId ? { projectId: currentProjectId } : {},
          replace: true,
        });
      }

      // Defer project query invalidation so it doesn't trigger refetches/re-renders
      // during the critical streaming startup window
      const projectIdForInvalidation = searchProjectIdRef.current;
      if (projectIdForInvalidation) {
        clearTimeout(projectInvalidationTimer.current);
        projectInvalidationTimer.current = window.setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', projectIdForInvalidation] });
          queryClient.invalidateQueries({ queryKey: ['projects', projectIdForInvalidation] });
        }, 5000);
      }

      // Clear pending fields AFTER navigation so that the effectiveSessionId guard
      // (pendingFirstMessage ? undefined : currentSessionId) never briefly exposes
      // the tmpId to API hooks. By the time we reach here, React has committed
      // setCurrentSessionId(realId), so clearing pendingFirstMessage is safe.
      // Only clear the optimistic ID guard here - pendingFirstMessage is cleared by
      // SessionMiddle once it has real data, to avoid a flash of empty content.
      setSessionLayout({ pendingOptimisticId: null });
    });

    return () => {
      unsubscribe();
      clearTimeout(projectInvalidationTimer.current);
    };
  }, [
    subscribeToAction,
    navigate,
    setCurrentSession,
    setCurrentSessionId,
    location.pathname,
    queryClient,
    migrateQuests,
    migrateSession,
  ]);

  // Measure SessionBottom height for dynamic positioning of scroll to bottom
  const sessionBottomRef = useRef<HTMLDivElement>(null);

  // Disable the collection subscription during active streaming to prevent dual-pipeline conflicts.
  const isStreaming = useStreamingState(s => (currentSessionId ? s.isStreamingSession(currentSessionId) : false));

  // Pass undefined while a new session is pending so subscription hooks don't fire
  // real API calls against the fake client-generated tmpId.
  const effectiveSessionId = pendingFirstMessage ? undefined : currentSessionId;
  useSubscribeToSessionQuests(effectiveSessionId, isStreaming);
  useSubscribeToSession(effectiveSessionId);

  // Memoized layout styles
  const layoutStyles = useMemo(() => {
    const isHorizontal = layout === 'horizontal';
    const isVertical = layout === 'vertical';
    const isPip = layout === 'pip';
    const isHide = layout === 'hide';
    const isNoAI = layout === 'noAI';
    const isFloatingChat = layout === 'floatingChat';
    const isDocked = layout === 'dockRight' || layout === 'dockBottom';

    // Force horizontal layout on mobile devices for better UX
    const effectiveIsHorizontal = isMobile && isVertical ? true : isHorizontal;
    const effectiveIsVertical = isMobile && isVertical ? false : isVertical;

    return {
      knowledge: isHide
        ? { visibility: 'hidden' as const, width: 0, height: 0, opacity: 0 }
        : isPip || isFloatingChat || isDocked
          ? { width: '100%', height: '100%' }
          : effectiveIsHorizontal
            ? { width: '100%', height: '50%' }
            : effectiveIsVertical
              ? { width: `${knowledgeViewerWidth}%`, height: '100%' }
              : { width: '100%', height: '100%' },

      chat: effectiveIsHorizontal
        ? { width: '100%', height: '50%' }
        : effectiveIsVertical
          ? { width: `${100 - knowledgeViewerWidth}%`, height: '100%' }
          : { width: '100%', height: '100%' },

      session: isNoAI
        ? { visibility: 'hidden' as const, display: 'none' as const, opacity: 0 }
        : isPip
          ? {
              position: 'fixed' as const,
              width: '40vw',
              height: '50vh',
              zIndex: 1200,
              bottom: '10px',
              right: '10px',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '8px',
              backgroundColor: 'background.surface',
              overflow: 'hidden',
              boxShadow: (theme: any) => theme.palette.session.shadowLight,
            }
          : isFloatingChat || isDocked
            ? {
                // FloatingChat/Dock modes: chat is rendered inside FloatingChatWindow or DockedChatPanel
                display: 'none' as const,
              }
            : {},
    };
  }, [layout, knowledgeViewerWidth, isMobile]);

  // Track previous session ID to detect explicit "clear session" transitions
  const previousSessionIdRef = useRef(currentSessionId);

  // Track the last session ID we asked changeSession to open. changeSession only
  // updates contextSessionId on success, so when an open fails (e.g. the session
  // is inaccessible and the API 404s) the `currentSessionId !== contextSessionId`
  // guard below stays true. Without this ref, the effect would re-invoke
  // changeSession - and re-hit the failing API - on every subsequent render.
  const attemptedSessionIdRef = useRef<string | null>(null);

  // Change the session if the currentSessionId changes
  useEffect(() => {
    // Only call changeSession if it's different from context, and we haven't
    // already attempted to open this exact session (prevents a retry loop when
    // the open fails and contextSessionId never advances).
    if (shouldAttemptSessionOpen(currentSessionId, contextSessionId, isLoading, attemptedSessionIdRef.current)) {
      attemptedSessionIdRef.current = currentSessionId;
      void changeSession(currentSessionId);

      // Record activity when opening a session
      recordSessionActivity(currentSessionId);
    }

    // When parent explicitly clears the session (e.g., "New notebook" on /opti),
    // also clear the sessions context so SessionBottom doesn't send messages
    // to the stale previous session.
    if (!currentSessionId && previousSessionIdRef.current) {
      setCurrentSessionId(null);
      setCurrentSession(null);
      // Allow re-attempting any session next time one is selected, including the
      // one we just left (re-opening it should re-run the open flow).
      attemptedSessionIdRef.current = null;
    }

    previousSessionIdRef.current = currentSessionId;
  }, [currentSessionId, contextSessionId, changeSession, isLoading, setCurrentSessionId, setCurrentSession]);

  // Reset pin filter when session changes
  useEffect(() => {
    setShowPinnedOnly(false);
  }, [currentSessionId, setShowPinnedOnly]);

  return (
    <ChatCompletionProvider sessionId={currentSessionId ?? null}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: layout === 'horizontal' || (isMobile && layout === 'vertical') ? 'column' : 'row',
          rowGap: layout === 'horizontal' || (isMobile && layout === 'vertical') ? '10px' : '0px',
          p: isMobile ? '0px' : '0px',
          height: '100%',
          width: '100%',
          position: layout === 'pip' ? 'static' : 'relative',
          gap: layout === 'horizontal' || (isMobile && layout === 'vertical') ? '10px' : '0px',
        }}
      >
        {layout !== 'hide' && layout !== 'dockRight' && layout !== 'dockBottom' && (
          <Box ref={knowledgeRef} sx={{ transition: 'all 0.3s ease', ...layoutStyles.knowledge }}>
            <KnowledgeViewer autoHideOnEmpty={autoHideOnEmpty} />
          </Box>
        )}
        {/* Resizable splitter - only show in vertical layout when KnowledgeViewer is visible (and not on mobile) */}
        {layout === 'vertical' && !isMobile && <ResizableSplitter />}
        <Box
          ref={chatContainerRef}
          display="flex"
          sx={{
            transition: 'all 0.3s ease',
            visibility: 'visible',
            opacity: 1,
            ...(layout === 'pip' ? {} : layoutStyles.chat),
            ...layoutStyles.session,
            position: layout === 'pip' ? 'fixed' : 'relative',
          }}
        >
          <Box
            flexGrow={1}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {isDraggingOver && <DropFilesOverlay />}
            <Box
              sx={{
                width: '100%',
                height: '100%',
                border: layout === 'hide' || layout === 'pip' ? 'none' : '1px solid',
                borderRadius: '8px',
                borderColor: 'divider',
                marginX: 'auto',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                // overflow: 'hidden', // Prevent content from escaping flex container on mobile
                pt: {
                  xs: project ? '60px' : 0,
                  sm: '60px',
                },
              }}
            >
              {/** SessionTop component */}
              <Box
                sx={theme => ({
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '60px',
                  borderColor: 'divider',
                  background: theme.palette.background.body,
                  zIndex: 1,
                  padding: '0px 0 0px 12px',
                  display: {
                    xs: project ? 'block' : 'none',
                    sm: 'block',
                  },
                })}
              >
                <SessionTop listClosed={listClosed} onChatWidthToggle={setIsFullWidth} />
              </Box>
              {/* Skip rendering chat content when floatingChat/dock is active — FloatingChatWindow
                or DockedChatPanel renders its own SessionMiddle + SessionBottom. Rendering duplicates
                here causes the hidden editor's SyncValuePlugin to call selectEnd() on every keystroke,
                which updates the global browser Selection API and steals focus from the visible editor. */}
              {layout !== 'floatingChat' && layout !== 'dockRight' && layout !== 'dockBottom' && (
                <>
                  {!currentSessionId ? (
                    customSplash || <NotebookSplash />
                  ) : (
                    <Box sx={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <SessionMiddle
                        isFullWidth={isFullWidth}
                        sessionId={currentSessionId}
                        emptySessionSplash={emptySessionSplash}
                      />
                      {pendingFirstMessage && (
                        <Box
                          sx={{
                            position: 'absolute',
                            inset: 0,
                            zIndex: 10,
                            display: 'flex',
                            flexDirection: 'column',
                            backgroundColor: 'background.body',
                          }}
                        >
                          <PendingFirstMessage message={pendingFirstMessage} />
                        </Box>
                      )}
                    </Box>
                  )}
                  {/* ActiveAgentExecutions used to live here as a fixed block
                    above SessionBottom, which created visual disconnect between
                    the user's prompt (rendered in the scrollable chat middle)
                    and the agent's live activity (parked at the bottom of the
                    viewport). It now renders inside ChatHistory's footer so
                    iteration streams and permission cards appear directly under
                    the last chat bubble and scroll with the rest of the
                    conversation. SessionBottom stays as the fixed input bar. */}
                  <Box
                    sx={{
                      flexShrink: 0,
                      width: '100%',
                      borderColor: 'divider',
                      backgroundColor: 'background.body',
                      zIndex: 10,
                    }}
                  >
                    <SessionBottom ref={sessionBottomRef} />
                  </Box>
                </>
              )}
            </Box>
          </Box>

          {!!pastedFile && (
            <Modal open onClose={() => handleConfirmUpload(false)}>
              <ModalDialog maxWidth="sm">
                <Typography component="h2">Confirm Upload</Typography>
                <Typography>Do you want to upload the file {pastedFile?.name}?</Typography>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                  <Button onClick={() => handleConfirmUpload(false)} color="neutral" variant="plain">
                    Cancel
                  </Button>
                  <Button onClick={() => handleConfirmUpload(true)} sx={{ marginLeft: '0.5rem' }}>
                    Upload
                  </Button>
                </div>
              </ModalDialog>
            </Modal>
          )}
        </Box>

        {/* Floating Chat Window - renders when layout is floatingChat */}
        {layout === 'floatingChat' && (
          <FloatingChatWindow headerActions={floatingChatHeaderActions}>
            <Box
              ref={containerRef}
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'background.surface',
              }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              {isDraggingOver && <DropFilesOverlay />}
              {/* Chat content without SessionTop header for compact floating view.
                  pb mirrors the docked panel: keeps the last message's action row
                  off the input divider since the input has no top padding. */}
              <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', pb: '12px' }}>
                {!currentSessionId ? (
                  customSplash || <NotebookSplash />
                ) : (
                  <Box
                    sx={{
                      position: 'relative',
                      flex: 1,
                      minHeight: 0,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <SessionMiddle
                      isFullWidth={false}
                      sessionId={currentSessionId}
                      emptySessionSplash={emptySessionSplash}
                    />
                    {pendingFirstMessage && (
                      <Box
                        sx={{
                          position: 'absolute',
                          inset: 0,
                          zIndex: 10,
                          display: 'flex',
                          flexDirection: 'column',
                          backgroundColor: 'background.body',
                        }}
                      >
                        <PendingFirstMessage message={pendingFirstMessage} />
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
              {/* Input area */}
              <Box
                sx={{
                  flexShrink: 0,
                  width: '100%',
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  backgroundColor: 'background.body',
                }}
              >
                <SessionBottom ref={sessionBottomRef} />
              </Box>
            </Box>
          </FloatingChatWindow>
        )}

        {/* Docked Chat Panel - renders when layout is dockRight or dockBottom */}
        {(layout === 'dockRight' || layout === 'dockBottom') && (
          <DockedChatPanel headerActions={floatingChatHeaderActions}>
            <Box
              ref={containerRef}
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'background.surface',
              }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              {isDraggingOver && <DropFilesOverlay />}
              {/* pb keeps the last message's action row from touching the input divider
                  now that the docked input has no top padding of its own. */}
              <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', pb: '12px' }}>
                {!currentSessionId ? (
                  customSplash || <NotebookSplash />
                ) : (
                  <SessionMiddle
                    isFullWidth={false}
                    sessionId={currentSessionId}
                    emptySessionSplash={emptySessionSplash}
                  />
                )}
              </Box>
              <Box
                sx={{
                  flexShrink: 0,
                  width: '100%',
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  backgroundColor: 'background.body',
                }}
              >
                <SessionBottom ref={sessionBottomRef} />
              </Box>
            </Box>
          </DockedChatPanel>
        )}
      </Box>
    </ChatCompletionProvider>
  );
};

export default SessionContainer;

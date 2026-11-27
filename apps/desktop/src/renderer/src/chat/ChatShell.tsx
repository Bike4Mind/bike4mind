import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import type { AttentionOpenEvent } from '@shared/attention';
import type { AuthState } from '@shared/auth';
import { DEFAULT_PROMPT_CACHE_TTL, type PromptCacheTtl } from '@bike4mind/common';
import type { ChatArtifact, ChatModelOption, ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import type { StudioMediaKind } from '@shared/studio';
import { promptHistory } from '@shared/threadRewind';
import type { SkillMarketListingRef } from '@shared/skillMarket';
import type { SkillsScope } from '@shared/skills';
import {
  canSpawnDeeper,
  findModelOption,
  isLocalBackend,
  isLocalModel,
  modelSupportsTools,
  SESSION_TITLE_MAX_LENGTH,
} from '@shared/chat';
import { hostChat } from '../host/hostChat';
import { composerBlock, isLocalMode, noLocalModels } from './noLocalModels';
import { closingText, plainText, snippetOf } from '@shared/agentOutcome';
import { effectiveContextLimit, occupiedTokens } from '@shared/contextLimit';
import { LOCAL_SERVER_ID } from '@shared/modelServers';
import type { ModelSettings } from '@shared/modelSettings';
import { alertableSessions, needsYouBadgeCount } from '@shared/needsYou';
import { activeTodos } from '@shared/todos';
import { ArtifactLibraryPanel } from './ArtifactLibraryPanel';
import { MissionControl } from './missionControl/MissionControl';
import { useMissionControlActions } from './missionControl/useMissionControlActions';
import { BlankChat, BlankChatGreeting } from './BlankChat';
import { SkillMarketPanel } from './SkillMarketPanel';
import { BackgroundTaskChip, BackgroundTaskPanel } from './BackgroundTaskPanel';
import { readPanelFlag, spawnedSessions, writePanelFlag } from './backgroundTasks';
import { BrowserPane } from './BrowserPane';
import { SimulatorPane } from './SimulatorPane';
import { ModelPane, type PartEditTurn } from './ModelPane';
import { useModelBackgroundBuilds } from './model3d/useModelBackgroundBuilds';
import { useModelEngine } from './model3d/useModelEngine';
import { useSimulatorView } from './useSimulatorView';
import { readBrowserPaneOpen, writeBrowserPaneOpen } from './agentBrowser';
import { ApprovalModePill } from './ApprovalModePill';
import { Composer } from './Composer';
import { useLoop } from './LoopBar';
import { CustomizeScreen, useCustomizeAttention } from './CustomizePanel';
import { AgentsPlace } from './rail/AgentsPlace';
import { agentsBoard } from './rail/agentsBoard';
import { PlaceRail, type RailAccountContext } from './rail/PlaceRail';
import {
  isSessionPlace,
  placeHasSidebar,
  readPlaceMemory,
  writePlaceMemory,
  type Place,
  type SessionPlace,
  type StudioArea,
} from './rail/places';
import { STUDIO_STARTING, useStudioSession } from './rail/studioSession';
import { usePlaceShortcuts } from './rail/shortcuts';
import { StudioMain } from './rail/StudioPlace';
import { LibraryMain, LibrarySidebar } from './rail/LibraryPlace';
import type { LibraryFilter } from './library/libraryFeed';
import { readSidebarWidth } from './sidebarWidth';
import type { ModelsInUse } from '../models/InstalledTab';
import type { ComposerFill } from './composerInput';
import { ModelsScreen } from '../models/ModelsScreen';
import { ComposerOllamaNotice } from '../models/OllamaNotRunning';
import { useModelServers } from '../models/useModelHub';
import { ConversationIcon, PanelRightIcon, StatsIcon } from './icons';
import { PresenterPendingNotice } from './PresenterPendingNotice';
import { OpenPaneButtons, PanesMenu, type PaneControl } from './PanesMenu';
import { SessionArtifactsButton } from './SessionArtifactsButton';
import { paneDocument, sessionArtifacts, type SessionArtifact } from './sessionArtifacts';
import { StudioPane } from './studio/StudioPane';
import { StudioProductions } from './studio/productions/StudioProductions';
import type { StudioController } from './studio/controller';
import { useStudioController } from './studio/useStudioController';
import { studioPaneLayout } from './studio/layout';
import { railFitsBesideThread, replyStatsToggleTitle, setReplyStatsRail, useReplyStatsPrefs } from './replyStatsPrefs';
import { MessageThread } from './MessageThread';
import {
  chatShellRootSx,
  COLUMN_LAYOUT_TRANSITION,
  columnStackSx,
  contentColumnSx,
  SESSION_PANEL_SPACE_VAR,
} from './layout';
import { ModelPicker } from './ModelPicker';
import { modelSwitchCredits } from './modelSwitchCost';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { GenerationSettingsPicker } from './GenerationSettingsPicker';
import { PromptCacheTtlPicker } from './PromptCacheTtlPicker';
import { TuneTray } from './TuneTray';
import { CacheExpiryNote } from './CacheExpiryNote';
import { ContextRing } from './ContextRing';
import { GrantedFolderChips, SessionChips } from './SessionChips';
import { SESSION_PANEL_ID, SessionPanel } from './SessionPanel';
import { SESSION_PANEL_SPACE, sessionPanelLayout, useElementWidth, useSessionPanelPrefs } from './sessionPanelState';
import { createPullRequestPrompt } from './changesBarModel';
import { useWorkspaceChanges } from './useWorkspaceChanges';
import { openInSessionBrowser } from './prLinks';
import { usePrSummaries, usePullRequest } from './usePullRequest';
import { SessionList } from './SessionList';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { isUntouchedImport, nestedSessionsOf, projectForGroup, projectGroupDirectory } from './grouping';
import { useImportedInline } from './importedInline';
import { TerminalPanel } from './TerminalPanel';
import {
  isTerminalToggle,
  readTerminalOpenSessions,
  withTerminalOpen,
  writeTerminalOpenSessions,
} from './terminalPanelState';
import { TodoPanel } from './TodoPanel';
import { HeldRelayCard } from './HeldRelayCard';
import { SessionOpenerContext } from './SessionLink';
import { clampQuote, quotedMessage } from './quotedReply';
import { SpawnSuggestionTray } from './SpawnSuggestionTray';
import { ChildrenStrip } from './ChildrenStrip';
import { useSpawnLocation } from './spawnLocationSetting';
import { useHeldRelays } from './useHeldRelays';
import { TaskDecisionCards, decisionsFor, useTaskDecisions } from './TaskDecisionCards';
import { pendingDecisionOf } from '@shared/orchestration';
import { useSpawnSuggestions } from './useSpawnSuggestions';
import { TurnDot, turnState } from './TurnDot';
import { TurnStatus } from './TurnStatus';
import { workspacePhrase } from './workspaceProgress';
import { canHoldWorktree, worktreeByDefault } from './worktreeDefault';
import { presentReply } from './codeStream';
import { seedOnArrival } from './firstRunSeed';
import { readLastSession, useLastSession } from './lastSession';
import { launchPlace, resolveLaunch, useFirstLaunchPlace } from './rail/launchPlace';
import { newSessionInProject } from './newSessionInProject';
import { isSessionDraft, useSessionDraft } from './useSessionDraft';
import { roundsOf } from './replyRounds';
import { describeActivity, latestReply, writingProse, type ComposerUsage } from './statusLine';
import { useAccountCredits } from './useAccountCredits';
import { ImageMenuProvider } from './ImageContextMenu';
import { FilePathLinkProvider, type ShowFile } from './FilePathLink';
import { FilePane, type TextFileView } from './FilePane';
import { toAttachmentInputs, useAttachmentDraft } from './useAttachments';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { useVideoJobs, VideoJobsContext } from './useVideoJobs';
import { ArtifactBrowserContext, openArtifactInSessionBrowser } from './ArtifactCard';
import { WebLinkContext } from './WebResults';
import { useConversation, useModelCatalog, useSessionStatusFeed, useSessions, type SessionPlacement } from './useChat';
import { useSidebarSections } from './useSidebarSections';
import { usePromptSuggestion } from './usePromptSuggestion';
import { useFileDrop } from './useFileDrop';
import { useSkills } from './useSkills';
import { useSessionStartTiming } from './useSessionStartTiming';
import { SpawnFailureToast } from './SpawnFailureToast';
import { useCreationTools } from './useCreationTools';
import { OrchestratePill } from './orchestrator/OrchestratePill';
import { OrchestrateToggle } from './orchestrator/OrchestrateToggle';
import { ExampleQuestStrip } from './orchestrator/exampleQuests';
import { markSessionViewed } from './markSessionViewed';
import { ambientHeld, isEditable, isPrintableKey, useAmbientSettle } from './orchestrator/ambient';
import { inSceneDialogue } from './orchestrator/scene/dialogue';
import type { AgentActions, InnkeeperDesk, StageAmbient } from './orchestrator/OrchestratorStage';
import { OrchestratorSurface } from './orchestrator/OrchestratorSurface';
import { agentsSurfaceAvailable as isAgentsSurfaceAvailable } from './orchestrator/agentsSurface';
import { archivedAgentsOf } from '@shared/spawnTree';
import {
  readAmbientHintSeen,
  readIntroSeen,
  writeAmbientHintSeen,
  writeIntroSeen,
  writeSurface,
} from './orchestrator/orchestratorPrefs';
import { singlePaneLayout, type OrchestratorLayout } from './orchestrator/orchestratorLayout';
import { renderOrchestratorView } from './orchestrator/viewRegistry';
import { ORCHESTRATOR_VIEW_INFO, useSceneStageCopy } from './orchestrator/ViewSwitcher';
import { latestQuestReport } from './orchestrator/finale';
import { agentStates, descendantIds } from './orchestrator/roster';
import { prefersReducedMotion } from './orchestrator/motion';
import { ThreadDock, type ThreadDockMode } from './orchestrator/ThreadDock';
import { useOrchestratorPrefs } from './orchestrator/useOrchestrator';
import { useFillWindow } from './orchestrator/useFillWindow';
import { useNeedsYouAlerts } from './orchestrator/useNeedsYouAlerts';
import { SidebarSyncHints } from './SyncHints';
import { useNewChatRequests } from '../appMenu/newChatRequests';
import type { ClaudeImportKind } from '@shared/claudeImport';

/** How long the orchestrator's "Read the report" keeps the summary highlighted (ms). */
const REPORT_HIGHLIGHT_MS = 2400;

function reportReply(thread: HTMLElement | null, reportId: string): HTMLElement | undefined {
  const replies = thread?.querySelectorAll<HTMLElement>('[data-assistant-reply]') ?? [];
  return [...replies].find(reply => reply.dataset.messageId === reportId);
}

function SessionHeader({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    else setDraft(title);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        size="sm"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(title);
            setEditing(false);
          }
        }}
        slotProps={{ input: { maxLength: SESSION_TITLE_MAX_LENGTH, 'data-testid': 'chat-rename-input' } }}
      />
    );
  }

  return (
    <Typography
      level="title-sm"
      noWrap
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      sx={{ cursor: 'text' }}
      data-testid="chat-session-title"
    >
      {title}
    </Typography>
  );
}

/**
 * What the main pane is showing. One value rather than a flag per screen, so the screens
 * cannot both be up and nothing has to remember to shut the other one.
 */
type ChatScreen = 'conversation' | 'artifacts' | 'mission-control' | 'customize' | 'skill-market' | 'models';

/**
 * The rail's account slot, given the turn dot and the screens this shell owns.
 *
 * A function rather than a node because the halves are owned in different places: this
 * component knows the turn state and its screens, and the slot knows the account and the
 * routes. Handing them down keeps both where they belong - see TurnDot.
 */
export type AccountStrip = (context: RailAccountContext) => ReactNode;

/** How long the first-run tavern intro plays before it is marked seen (ms). */
const ORCHESTRATOR_INTRO_MS = 1500;
/** The intro always plays in the Tavern alone, whatever layout the session is on. */
const INTRO_LAYOUT = singlePaneLayout('tavern');

/**
 * 'playing' while the first-run intro runs, then 'shown' until the user picks a view: the intro is
 * staged in the tavern, so that view is forced for the whole first entry without touching the pref.
 */
type IntroPhase = 'off' | 'playing' | 'shown';

/** Key of the Add folder alert for a failure before any chat existed. */
const NO_CHAT = '';

/** An Add folder failure, or the warning that came back from a share into a chat that was not open. */
interface AddFolderAlert {
  text: string;
  color: 'danger' | 'warning';
}

/** A danger alert: `lead`, plus the main-side reason with Electron's IPC wrapper stripped, when there is one. */
function failure(lead: string, error: unknown): AddFolderAlert {
  const reason = error instanceof Error ? error.message : String(error);
  const detail = reason.replace(/^Error invoking remote method '[^']*': (?:Error(?:: |$))?/, '');
  return { text: detail ? `${lead}: ${detail}` : lead, color: 'danger' };
}

export function ChatShell({
  auth,
  account,
  onOpenModelServers,
  onOpenImportSettings,
  updateNotice,
  studio: suppliedStudio,
}: {
  auth?: AuthState | null;
  account?: AccountStrip;
  updateNotice?: ReactNode;
  onOpenModelServers?: () => void;
  /** Settings > Import, scrolled to one source; the sidebar's sync hints are shown only with it. */
  onOpenImportSettings?: (focus: ClaudeImportKind) => void;
  studio?: StudioController;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [placeMemory] = useState(readPlaceMemory);
  const [launch] = useState(() =>
    resolveLaunch({ preference: launchPlace(), memory: placeMemory, lastSession: readLastSession() })
  );
  const remembered = launch.session;
  // The session to restore and the open one are fetched even when no loaded page holds them.
  const keepIds = useMemo(
    () => [remembered?.id, isSessionDraft(activeId) ? null : activeId].filter((id): id is string => !!id),
    [remembered, activeId]
  );
  const {
    sessions,
    loading,
    reload,
    createStudio,
    creatingCode,
    codeError,
    clearCodeError,
    remove,
    togglePin,
    setOrchestratorLabel,
    toggleArchived,
    rename,
    renameError,
    clearRenameError,
    exportSession,
    exportError,
    clearExportError,
    apply,
    hasMore,
    loadingMore,
    loadMore,
    total: sessionTotal,
    searchSessions,
  } = useSessions(keepIds);
  const sessionPaging = useMemo(
    () => ({ hasMore, loadingMore, onLoadMore: loadMore, total: sessionTotal }),
    [hasMore, loadingMore, loadMore, sessionTotal]
  );
  const {
    sections: userSections,
    actions: sectionActions,
    adopt: adoptSections,
    placementFailed: reportPlacementFailure,
    error: sectionError,
    dismissError: dismissSectionError,
  } = useSidebarSections();
  const [place, setPlace] = useState<Place>(launch.place);
  // The session mode the list filters by and New starts. A session place sets it; Studio leaves
  // it alone, so the conversation open underneath stays open for the return trip.
  const [mode, setModeOnly] = useState<SessionPlace>(launch.mode);
  /** Opening a session in a mode takes the user to that mode's place. */
  const setMode = useCallback((next: SessionPlace) => {
    setModeOnly(next);
    setPlace(next);
  }, []);
  const onRestore = useCallback((session: ChatSessionSummary | null) => {
    const restoredMode = session && isSessionPlace(session.mode) ? session.mode : 'chat';
    setModeOnly(current => (session ? restoredMode : current));
    // Studio, Agents and Library are not where a session opens, so a restore leaves the user there.
    setPlace(current => (!isSessionPlace(current) || !session ? current : restoredMode));
    if (session) setActiveId(session.id);
  }, []);
  const restoring = useLastSession({ remembered, loading, sessions, activeId, onRestore });
  const detectingFirstPlace = useFirstLaunchPlace(launch.firstLaunch, setMode);
  // Until this is false the shell does not know which conversation it will show, so it draws
  // none of the empty-state copy that would otherwise flash up before the real one.
  const settling = loading || restoring || detectingFirstPlace;
  const [importedInline] = useImportedInline();

  const [addFolderAlerts, setAddFolderAlerts] = useState<Record<string, AddFolderAlert>>({});
  const clearAddFolderAlert = useCallback(
    (chatId: string) =>
      setAddFolderAlerts(current => {
        if (!(chatId in current)) return current;
        const { [chatId]: _dropped, ...rest } = current;
        return rest;
      }),
    []
  );
  const sessionDraft = useSessionDraft(setActiveId, reload);
  const persistedId = isSessionDraft(activeId) ? null : activeId;
  const persistedConversation = useConversation(persistedId, apply, clearAddFolderAlert);
  const conversation = sessionDraft.wrap(persistedConversation);
  const draftActive = isSessionDraft(activeId);
  // The header follows the sidebar's copy of the title, so a rename from any row - including
  // its optimistic title and any rollback - shows above the thread too.
  const activeSummary = useMemo(() => sessions.find(session => session.id === activeId), [sessions, activeId]);
  // A conversation picked before its transcript has been read would otherwise show the empty
  // thread's "send a message" line for a frame - or, on a switch, the PREVIOUS conversation's
  // transcript under this one's id until the read lands.
  const opening =
    settling || (!!activeId && conversation.session?.id !== activeId && conversation.openFailedFor !== activeId);
  // The composer's per-chat settings show conversation.session: the previous chat's while opening, none after a failed open.
  const chatSettingsLocked = !activeId || settling || conversation.session?.id !== activeId;
  const openFailed = !!activeId && conversation.openFailedFor === activeId && conversation.session?.id !== activeId;
  const spawnSuggestions = useSpawnSuggestions(conversation.session);
  const [spawnLocation] = useSpawnLocation();
  const heldRelays = useHeldRelays(persistedId);
  const taskDecisions = useTaskDecisions();
  const markSessionStart = useSessionStartTiming(sessions);
  const startSuggestion = spawnSuggestions.start;
  const onStartSuggestion = useCallback(
    (request: Parameters<typeof startSuggestion>[0]) => {
      if (request.placement !== 'here') markSessionStart('suggestion');
      return startSuggestion(request);
    },
    [startSuggestion, markSessionStart]
  );
  const background = useBackgroundProcesses(persistedId);
  const loop = useLoop(persistedId);
  const videoJobs = useVideoJobs(persistedId);
  const draftSession = draftActive ? sessionDraft.session : null;
  const skillsScope: SkillsScope | null = persistedId
    ? { sessionId: persistedId }
    : draftActive
      ? { draftDirectory: draftSession?.mode === 'code' ? (draftSession.project?.directory ?? null) : null }
      : null;
  const skills = useSkills(skillsScope);
  const localMode = isLocalMode(auth);
  const catalog = useModelCatalog(localMode);
  const noLocal = localMode ? noLocalModels(catalog) : null;
  const modelServers = useModelServers();
  const savedServers = useMemo(() => modelServers?.filter(server => !server.local), [modelServers]);
  const {
    statuses,
    preparing,
    unreadReplies,
    background: backgroundJobs,
    loaded: statusesLoaded,
  } = useSessionStatusFeed();
  const prSummaries = usePrSummaries();
  // Both derive from the pushed status feed and the session list, so they move with no polling.
  const needsYou = useMemo(() => needsYouBadgeCount(statuses, sessions), [statuses, sessions]);
  const board = useMemo(() => agentsBoard(sessions, statuses, unreadReplies), [sessions, statuses, unreadReplies]);
  const [collapsed, setCollapsed] = useState(false);
  const [screen, setScreen] = useState<ChatScreen>('conversation');
  useEffect(() => {
    if (!draftActive || screen !== 'conversation' || sessionDraft.session?.mode !== mode) {
      sessionDraft.discard();
      if (draftActive) setActiveId(null);
    }
  }, [draftActive, screen, mode, sessionDraft.discard, sessionDraft.session?.mode]);
  // Window chrome, so it is remembered per machine rather than per conversation. Seeded from
  // storage on the first render and written back on every change, which is the whole of the
  // persistence - see backgroundTasks.ts for the keys and the blocked-storage fallback.
  const [tasksOpen, setTasksOpen] = useState(() => readPanelFlag('open'));
  const [tasksWide, setTasksWide] = useState(() => readPanelFlag('wide'));
  const [browserOpen, setBrowserOpen] = useState(() => readBrowserPaneOpen());
  const simulatorView = useSimulatorView();
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  const darkMode = useTheme().palette.mode === 'dark';
  // Mounted here rather than in the pane so builds, GLB writes and screenshots keep working while it
  // is closed. Each conversation has its own model: the pane follows this one, and the background
  // builds keep every other conversation's model tools working.
  const modelEngine = useModelEngine(darkMode, persistedId);
  useModelBackgroundBuilds(persistedId, darkMode);
  const [modelOpen, setModelOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioArea, setStudioArea] = useState<StudioArea>(placeMemory?.studio ?? 'create');
  const [studioKind, setStudioKind] = useState<StudioMediaKind | null>(null);
  const inStudio = place === 'studio';
  const inAgents = place === 'agents';
  // The conversation's side panels (tasks, browser, files, model, simulator) belong to Chat and Code.
  const inSessionPlace = isSessionPlace(place);
  const inLibrary = place === 'library';
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [studioRegion, studioWidth] = useElementWidth();
  const studioContainer = useRef<HTMLDivElement | null>(null);
  const setStudioRegion = useCallback(
    (node: HTMLDivElement | null) => {
      studioContainer.current = node;
      studioRegion(node);
    },
    [studioRegion]
  );
  const studioAccountKey = `${auth?.environment.url ?? ''}:${auth?.user?.id ?? ''}:${auth?.status ?? ''}`;
  // The Studio place saves into its own session; the pane beside a conversation saves into that one.
  const studioSession = useStudioSession({
    active: inStudio,
    loading,
    sessions,
    remembered: placeMemory?.studioSession ?? null,
    create: createStudio,
  });
  const studioSelect = studioSession.select;
  const studioTarget = inStudio ? studioSession.sessionId : persistedId;
  const studioPlaceReason = studioSession.error ?? (studioSession.sessionId ? undefined : STUDIO_STARTING);
  const liveStudio = useStudioController(studioTarget, (studioOpen || inStudio) && !suppliedStudio, studioAccountKey);
  const studio = suppliedStudio ?? liveStudio;
  // Per conversation rather than one flag: see terminalPanelState.ts.
  const [terminalSessions, setTerminalSessions] = useState(readTerminalOpenSessions);
  // Which conversation last asked for the keyboard to go to its terminal; see TerminalPanel.
  const [terminalFocus, setTerminalFocus] = useState<{ sessionId: string; seq: number } | null>(null);
  const draft = useAttachmentDraft(activeId);
  const nextPrompt = usePromptSuggestion(persistedId);
  const blankChatId =
    screen === 'conversation' &&
    !opening &&
    activeId &&
    conversation.session?.mode === 'chat' &&
    conversation.messages.length === 0
      ? activeId
      : null;
  const creationTools = useCreationTools(
    `${auth?.status ?? 'none'}:${auth?.environment.url ?? ''}:${auth?.user?.id ?? 'device-local'}`,
    blankChatId,
    conversation.session?.model
  );
  // Cleared once the composer takes it, or a composer remounted by another screen would take it again.
  const [composerFill, setComposerFill] = useState<ComposerFill | null>(null);
  const fillSeq = useRef(0);
  const fillComposer = useCallback((text: string) => setComposerFill({ id: ++fillSeq.current, text }), []);
  const clearComposerFill = useCallback(() => setComposerFill(null), []);
  const [composerFocus, setComposerFocus] = useState(0);
  // Per conversation, like the composer's own drafts: a quote waits in the one it was taken in.
  // One quote at a time - a second Reply replaces the first, so "Regarding:" always names exactly
  // one passage; to discuss a longer stretch, highlight the longer stretch.
  const [quotes, setQuotes] = useState<Readonly<Record<string, string>>>({});
  // Keyed by the conversation it was raised in, so it does not follow the user into another one.
  const [sideChatError, setSideChatError] = useState<{ sessionId: string; error: string } | null>(null);
  // Only the conversation screen counts as showing one: main polls what is on screen faster.
  const pullRequest = usePullRequest(screen === 'conversation' ? persistedId : null);
  // What the browser pane trades width with; see BrowserPane.
  const conversationColumn = useRef<HTMLDivElement | null>(null);
  const panelPrefs = useSessionPanelPrefs();
  // The thread region the session panel floats over; its width decides docked or popover.
  const [threadRegion, threadRegionWidth] = useElementWidth<HTMLDivElement>();
  const [panelPopoverOpen, setPanelPopoverOpen] = useState(false);
  const panelToggle = useRef<HTMLButtonElement | null>(null);
  const panesMenuButtonRef = useRef<HTMLButtonElement>(null);

  // The listing the market opens onto, when it was opened for one (an update badge).
  const [marketListing, setMarketListing] = useState<SkillMarketListingRef | null>(null);
  const openSkillMarket = useCallback((listing?: SkillMarketListingRef) => {
    setMarketListing(listing ?? null);
    setScreen('skill-market');
  }, []);

  const setTasksPanelOpen = useCallback((next: boolean) => {
    setTasksOpen(next);
    writePanelFlag('open', next);
  }, []);
  const toggleTasksWide = useCallback(() => {
    setTasksWide(current => {
      writePanelFlag('wide', !current);
      return !current;
    });
  }, []);
  // The agent attaching a device (simulator_view) is the user asking to watch, so it opens the pane.
  const simulatorAttached = simulatorView.status !== 'idle';
  useEffect(() => {
    if (simulatorAttached) setSimulatorOpen(true);
  }, [simulatorAttached]);
  // Closing stops the stream: nothing should keep capturing a screen nobody is looking at.
  const toggleSimulator = useCallback(() => {
    setSimulatorOpen(current => {
      if (current) void window.b4m.simulator.detach();
      return !current;
    });
  }, []);
  // The agent opening a model (model_view) is the user asking to see it, so a new path opens the pane;
  // a conversation opens with its pane showing its own model, or closed when it has none.
  const modelPath = modelEngine.state.path;
  const modelPaneFor = useRef(activeId);
  useEffect(() => {
    if (modelPaneFor.current !== activeId) {
      modelPaneFor.current = activeId;
      setModelOpen(modelPath !== null);
    } else if (modelPath) setModelOpen(true);
  }, [activeId, modelPath]);
  const toggleModel = useCallback(() => setModelOpen(current => !current), []);
  // The file a link opened, held for the conversation it was opened in so it never follows the
  // user into another one. `requested` is the path as the reply wrote it, which main re-resolves.
  const [openFile, setOpenFile] = useState<{ sessionId: string; requested: string; view: TextFileView } | null>(null);
  const fileSelectionEpoch = useRef(0);
  const showFile = useCallback<ShowFile>(
    (requested, view) => {
      if (activeId) setOpenFile({ sessionId: activeId, requested, view });
    },
    [activeId]
  );
  const closeFile = useCallback(() => {
    fileSelectionEpoch.current += 1;
    setOpenFile(null);
  }, []);
  const openFileExternally = useCallback(
    (requested: string) =>
      activeId
        ? window.b4m.chat.openFilePath(activeId, requested)
        : Promise.resolve({ ok: false as const, error: 'No conversation is open.' }),
    [activeId]
  );
  const toggleBrowser = useCallback(() => {
    setBrowserOpen(current => {
      writeBrowserPaneOpen(!current);
      return !current;
    });
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      // History search spans both modes, so the owning mode follows the selected result.
      const selected = sessions.find(session => session.id === sessionId);
      setScreen('conversation');
      // A Studio session is never a conversation in the list: it opens as the Studio place's Create.
      if (selected?.mode === 'studio') {
        studioSelect(selected.id);
        setStudioArea('create');
        setPlace('studio');
        return;
      }
      if (selected) setMode(selected.mode);
      setActiveId(sessionId);
      markSessionViewed(sessionId);
    },
    [sessions, studioSelect]
  );

  const terminalOpen = !!activeId && terminalSessions.includes(activeId);
  const setTerminalOpen = useCallback((sessionId: string, open: boolean) => {
    setTerminalSessions(current => {
      const next = withTerminalOpen(current, sessionId, open);
      writeTerminalOpenSessions(next);
      return next;
    });
  }, []);
  const toggleTerminal = useCallback(() => {
    if (!activeId) return;
    setTerminalOpen(activeId, !terminalOpen);
    if (!terminalOpen) setTerminalFocus(current => ({ sessionId: activeId, seq: (current?.seq ?? 0) + 1 }));
  }, [activeId, terminalOpen, setTerminalOpen]);
  const hideTerminal = useCallback(() => {
    if (activeId) setTerminalOpen(activeId, false);
  }, [activeId, setTerminalOpen]);

  // A focus request belongs to the conversation it was made in; switching away and back must not
  // pull the keyboard out of the composer.
  useEffect(() => setTerminalFocus(null), [activeId]);

  const toggleTerminalRef = useRef(toggleTerminal);
  toggleTerminalRef.current = toggleTerminal;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalToggle(event) || screenRef.current !== 'conversation') return;
      event.preventDefault();
      toggleTerminalRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const showBrowserPane = useCallback(() => {
    setBrowserOpen(true);
    writeBrowserPaneOpen(true);
  }, []);
  const setHistory = conversation.setHistory;
  const onHistory = useCallback((enabled: boolean) => void setHistory(enabled), [setHistory]);
  const openInBrowserPane = useCallback(
    (url: string) => openInSessionBrowser(url, activeId, showBrowserPane),
    [activeId, showBrowserPane]
  );
  const openArtifactInBrowserPane = useCallback(
    (artifact: Pick<ChatArtifact, 'title' | 'content' | 'identifier'>) =>
      openArtifactInSessionBrowser(artifact, activeId, showBrowserPane),
    [activeId, showBrowserPane]
  );
  const artifactsInSession = useMemo(() => sessionArtifacts(conversation.messages), [conversation.messages]);
  const reportedChildIds = useMemo(
    () =>
      new Set(
        conversation.messages.flatMap(message => {
          const id = message.reportedChildId ?? message.childReport?.sessionId;
          return id ? [id] : [];
        })
      ),
    [conversation.messages]
  );
  const openSessionArtifact = useCallback(
    ({ key, artifact }: SessionArtifact) =>
      openArtifactInSessionBrowser(
        { title: artifact.title, content: paneDocument(artifact) },
        activeId,
        showBrowserPane,
        request => window.b4m.browser.openArtifact({ ...request, artifactKey: key })
      ),
    [activeId, showBrowserPane]
  );

  const onFilesDropped = useCallback(
    (files: File[]) => {
      void toAttachmentInputs(files).then(inputs => draft.add(inputs));
    },
    [draft]
  );
  const drop = useFileDrop(onFilesDropped, !!activeId);

  /**
   * Whether the conversation's model is known NOT to read images.
   *
   * Only an explicit `false` blocks. The catalog carries the flag for the backends that report
   * it and is silent for the rest, so treating silence as "no" would refuse images on models
   * that handle them - the same reasoning the model picker applies to an unreadable list.
   */
  const modelOption = findModelOption(catalog.models, conversation.session?.model);
  // The last good read per model, so a failed re-read leaves the defaults it had rather than none.
  const [storedDefaults, setStoredDefaults] = useState<ReadonlyMap<string, ModelSettings | null>>(() => new Map());
  // A failed read, under the conversation whose model it was for.
  const [defaultsReadFailures, setDefaultsReadFailures] = useState<
    ReadonlyMap<string, { modelId: string; error: unknown }>
  >(() => new Map());
  const clearDefaultsReadFailure = useCallback(
    (sessionId: string) =>
      setDefaultsReadFailures(current => {
        if (!current.has(sessionId)) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      }),
    []
  );
  const defaultsModelId = modelOption && isLocalModel(modelOption.id) ? modelOption.id : null;
  const defaultsSessionId = conversation.session?.id ?? null;
  const modelDefaults = defaultsModelId ? (storedDefaults.get(defaultsModelId) ?? null) : null;
  const defaultEffort = modelDefaults?.effort ?? null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // Re-read on opening a chat and on returning from the Models screen, where the defaults are edited.
  useEffect(() => {
    if (!defaultsModelId || !defaultsSessionId || screen !== 'conversation') return;
    let live = true;
    const current = () => live && activeIdRef.current === defaultsSessionId;
    void Promise.resolve()
      .then(() => window.b4m.chat.getModelSettings(defaultsModelId))
      .then(
        settings => {
          if (!current()) return;
          setStoredDefaults(stored => new Map(stored).set(defaultsModelId, settings ?? null));
          clearDefaultsReadFailure(defaultsSessionId);
          // Also drop this model's failures stored for other chats: the read they report has since succeeded.
          setDefaultsReadFailures(failures => {
            const next = new Map(failures);
            for (const [id, failure] of failures) if (failure.modelId === defaultsModelId) next.delete(id);
            return next.size === failures.size ? failures : next;
          });
        },
        error => {
          if (!current()) return;
          setDefaultsReadFailures(failures =>
            new Map(failures).set(defaultsSessionId, { modelId: defaultsModelId, error })
          );
        }
      );
    return () => {
      live = false;
    };
  }, [defaultsModelId, defaultsSessionId, screen, clearDefaultsReadFailure]);
  const defaultsReadFailure =
    defaultsSessionId && defaultsSessionId === activeId ? defaultsReadFailures.get(defaultsSessionId) : undefined;
  const defaultsReadError =
    defaultsReadFailure && defaultsReadFailure.modelId === defaultsModelId
      ? failure(
          storedDefaults.has(defaultsReadFailure.modelId)
            ? "Desktop could not re-read this model's defaults from the Models screen, so Params and effort show the last ones it read, which may be out of date"
            : "Desktop could not read this model's defaults from the Models screen, so Params and effort show the built-in ones, which may not match what this chat sends",
          defaultsReadFailure.error
        ).text
      : null;
  const sessionCacheTtl = conversation.session?.promptCacheTtl ?? DEFAULT_PROMPT_CACHE_TTL;
  // Main sends the hour only to a model that takes it; see ChatService cacheTtlField.
  const cacheTtlFor = (model: ChatModelOption | undefined): PromptCacheTtl =>
    model?.supportsOneHourCache ? sessionCacheTtl : DEFAULT_PROMPT_CACHE_TTL;
  const modelsInUse = useMemo<ModelsInUse>(() => {
    const inUse = (id: string | undefined) => {
      const model = catalog.models.find(candidate => candidate.id === id && isLocalBackend(candidate));
      return model ? { serverId: model.server?.id ?? LOCAL_SERVER_ID, name: model.name } : null;
    };
    return {
      active: inUse(conversation.session?.model),
      conversations: sessions.filter(session => !session.archived).flatMap(session => inUse(session.model) ?? []),
    };
  }, [catalog.models, conversation.session?.model, sessions]);
  const block = composerBlock(
    noLocal,
    modelOption?.supportsVision === false && draft.attachments.some(attachment => attachment.kind === 'image')
      ? `${modelOption.name} cannot read images. Pick a model that can, or remove the image before sending.`
      : null
  );
  const blockedReason = block.reason;
  const blockedAction =
    block.action === 'open-models' ? { label: 'Open Models', onClick: () => setScreen('models') } : null;
  const reloadCatalog = catalog.reload;
  const blockedNotice =
    noLocal?.fix === 'start-ollama' ? (
      <ComposerOllamaNotice
        sessionId={activeId}
        launch={modelServers?.find(server => server.id === LOCAL_SERVER_ID)?.launch}
        reload={() => void reloadCatalog()}
      />
    ) : null;

  // Main saves the model a send would use as soon as one is listed, so the picker shows it.
  const settleLocalModel = conversation.settleLocalModel;
  const settledFor = useRef<string | null>(null);
  const sessionModel = conversation.session?.model;
  const sessionKey = conversation.session?.id;
  const listed = catalog.models.length > 0 && !catalog.loading;
  const modelListed = !!findModelOption(catalog.models, sessionModel);
  useEffect(() => {
    if (!localMode || !listed || !sessionKey || !sessionModel || modelListed) return;
    const key = `${sessionKey}:${sessionModel}:${catalog.models[0]?.id}`;
    if (settledFor.current === key) return;
    settledFor.current = key;
    void settleLocalModel();
  }, [localMode, listed, sessionKey, sessionModel, modelListed, catalog.models, settleLocalModel]);

  // A Code session with no project has no working directory, so main refuses the turn. The
  // centered workspace form is the thing to act on, and the composer names the state in one word
  // where the reader already looks for "can I send?". Main's refusal stays as the guard.
  const unbound = conversation.session?.mode === 'code' && !conversation.session.project;
  // Model tools exist only in Code sessions bound to a folder; an already-open model stays reachable anywhere.
  const modelAvailable =
    screen === 'conversation' &&
    ((conversation.session?.mode === 'code' && !unbound) || modelEngine.state.path !== null);

  /**
   * Whether this conversation HAS an agent browser to show.
   *
   * A conversation is all it takes, which is the same condition main offers the browser tools
   * on: the page is keyed on the conversation id and nothing about it is project-shaped. The
   * one thing it cannot do is belong to no conversation, so the toggle stays on screen and
   * disabled on the empty window rather than disappearing from it.
   */
  const browserAvailable = !!persistedId;

  // The header's pane toggles. The simulator and 3D model are left out where they cannot exist;
  // terminal and browser only lack a conversation, so they stay listed and say so.
  const paneControls: PaneControl[] = [
    {
      id: 'terminal',
      open: terminalOpen,
      unavailableReason: persistedId ? undefined : 'Open a conversation to use the terminal.',
      onToggle: toggleTerminal,
    },
    {
      id: 'browser',
      open: browserOpen && browserAvailable,
      unavailableReason: browserAvailable ? undefined : 'Open a conversation to use the browser.',
      onToggle: toggleBrowser,
    },
    ...(simulatorView.available ? [{ id: 'simulator' as const, open: simulatorOpen, onToggle: toggleSimulator }] : []),
    ...(modelAvailable ? [{ id: 'model' as const, open: modelOpen, onToggle: toggleModel }] : []),
    { id: 'studio', open: studioOpen, onToggle: () => setStudioOpen(open => !open) },
  ];

  // Re-read when a reply ends anywhere, which is the only moment this window knows the balance
  // moved. See useAccountCredits for why it is not polled.
  const credits = useAccountCredits(conversation.settledTurns);

  /**
   * Whether this conversation has a turn open, for the composer's controls.
   *
   * `conversation.streaming` is what THIS window knows of, from the stream or from main's live
   * copy when the conversation was opened, and it can lag main by one round trip either way.
   * The sidebar's status is main's own answer for every session at once, so it covers that gap. 'needs-action' counts: a turn parked
   * at the approval gate is still a turn, and the next message still queues behind it. A worker
   * waiting on a decision is the exception: its turn has ended, so typing there sends at once.
   */
  const sessionStatus = activeId ? statuses.get(activeId) : undefined;
  const awaitingDecision = pendingDecisionOf(activeSummary?.workerTask) !== undefined;
  const unreadReply = !!activeId && unreadReplies.has(activeId);
  const turnOpen =
    conversation.streaming ||
    sessionStatus === 'processing' ||
    (sessionStatus === 'needs-action' && !awaitingDecision && !unreadReply);
  const plan = useMemo(() => activeTodos(conversation.messages, turnOpen), [conversation.messages, turnOpen]);
  const sentPrompts = useMemo(() => promptHistory(conversation.messages), [conversation.messages]);

  const workspaceChanges = useWorkspaceChanges(
    screen === 'conversation' ? persistedId : null,
    conversation.session?.project,
    conversation.settledTurns
  );
  // A dismissed bar reports no binding, but the PR is still this session's, and offering to open
  // a second one for the same branch would be wrong. The sidebar summary covers the moment before
  // the bar's state arrives on a switch, except for a dismissed bar, which has no summary.
  const hasPullRequest =
    !!pullRequest?.binding || !!pullRequest?.dismissed || (!!activeId && prSummaries.has(activeId));
  const spawned = useMemo(() => spawnedSessions(sessions, statuses, activeId), [sessions, statuses, activeId]);
  // States only: the activity stream is subscribed inside OrchestratorSurface, while orchestrating.
  const spawnedStates = useMemo(
    () => agentStates(sessions, statuses, activeId, backgroundJobs),
    [sessions, statuses, activeId, backgroundJobs]
  );
  const orchestrationSession =
    sessionDraft.session && sessionDraft.session.id === conversation.session?.id ? conversation.session : activeSummary;
  // The view is remembered per sidebar group, so a Claude Code worktree shares its repository's choice. Only
  // the active session's project counts: a Code draft can briefly stand in for another session.
  const orchestrationProject = orchestrationSession?.id === activeId ? orchestrationSession.project : undefined;
  const orchestratorPrefs = useOrchestratorPrefs(
    activeId,
    orchestrationProject && projectGroupDirectory(orchestrationProject)
  );
  const { setDockOpen, setLayout: setOrchestratorLayout, setSurface: setOrchestratorSurface } = orchestratorPrefs;
  // A Code session can orchestrate before it has any agents; a Chat session only shows its agents.
  // One at the depth cap, or on a model sent no tools, could start none: main ignores its flag
  // there (orchestratesAgents, toolsSupported) and so does this.
  const orchestrateCapable =
    !!orchestrationSession?.project &&
    canSpawnDeeper(orchestrationSession) &&
    modelSupportsTools(orchestrationSession.model, findModelOption(catalog.models, orchestrationSession.model));
  const delegating = orchestrationSession?.orchestrate === true;
  const hasAgents = spawnedStates.length > 0;
  const hasArchivedAgents = useMemo(
    () => activeId !== null && archivedAgentsOf(sessions, activeId).length > 0,
    [sessions, activeId]
  );
  const agentsSurfaceAvailable = isAgentsSurfaceAvailable({
    session: orchestrationSession,
    hasAgents,
    hasArchivedAgents,
  });
  const orchestrating = orchestratorPrefs.surface === 'orchestrate' && agentsSurfaceAvailable;
  // Presenter mode redacts the stage (orchestrator/presenter.ts). Around it, the header names the root as
  // "Orchestrator" without its project line, and the trays above the composer, which quote agents' questions
  // and messages, are replaced by a neutral count until it is off.
  const presentingStage = orchestrating && orchestratorPrefs.presenter;
  const { setOrchestrate } = conversation;
  const staleAgentsSurface = !settling && !agentsSurfaceAvailable && orchestratorPrefs.surface === 'orchestrate';
  useEffect(() => {
    if (staleAgentsSurface) setOrchestratorSurface('chat');
  }, [staleAgentsSurface, setOrchestratorSurface]);
  const showExampleQuests =
    !opening &&
    !orchestrating &&
    orchestrateCapable &&
    delegating &&
    !hasAgents &&
    !turnOpen &&
    conversation.messages.length === 0;

  // Derived during render, not in an effect: a scene only plays its intro if introPlaying is
  // already true when it mounts, which is the same commit that enters orchestrate mode.
  const orchestrateEntry = orchestrating ? activeId : null;
  const [introEntry, setIntroEntry] = useState<string | null>(null);
  const [introPhase, setIntroPhase] = useState<IntroPhase>('off');
  if (orchestrateEntry !== introEntry) {
    setIntroEntry(orchestrateEntry);
    setIntroPhase(orchestrateEntry !== null && !readIntroSeen() ? 'playing' : 'off');
  }
  useEffect(() => {
    if (introPhase !== 'playing') return;
    const timer = window.setTimeout(() => {
      writeIntroSeen();
      setIntroPhase('shown');
    }, ORCHESTRATOR_INTRO_MS);
    return () => window.clearTimeout(timer);
    // introEntry too: a switch between two orchestrating sessions keeps the phase 'playing', and the
    // new session's intro still needs its full run.
  }, [introPhase, introEntry]);
  const orchestratorLayout = introPhase === 'off' ? orchestratorPrefs.layout : INTRO_LAYOUT;
  const orchestratorView = orchestratorLayout.panes[0].view;
  const ambientTalkLabel = useSceneStageCopy(orchestratorView).talk;
  // The ambient settle and the in-scene conversation are a single scene's; a split stage has neither.
  const orchestratorSplit = orchestratorLayout.panes.length > 1;
  // A scene that answers in place asks its agents' questions in its own dialogue box (OrchestratorStage
  // inSceneDecisions), so the tray above the composer keeps only this conversation's own decisions while it is up.
  const agentDecisionsInScene =
    orchestrating &&
    !presentingStage &&
    !orchestratorSplit &&
    ORCHESTRATOR_VIEW_INFO[orchestratorView].scene?.inSceneDecisions === true &&
    !orchestratorPrefs.focus;
  const threadHost = useRef<HTMLDivElement | null>(null);
  const dockToggle = useRef<HTMLButtonElement | null>(null);
  const [conversationRequest, setConversationRequest] = useState(0);
  // Fill window: the stage takes the whole window, with the rail, sidebar, header, session panel, dock and
  // composer out of the way until Exit or Escape. Never settles: its own header is already minimal.
  const fillWindow = useFillWindow(orchestrating && activeId !== null && screen === 'conversation' && inSessionPlace);

  // Focus lands on the header toggle, the way back in, rather than on a dock that just hid.
  const closeDock = useCallback(() => {
    setDockOpen(false);
    dockToggle.current?.focus();
  }, [setDockOpen]);
  const parentReport = useMemo(
    () => (conversation.session?.id === activeId ? latestQuestReport(conversation.messages) : undefined),
    [conversation.session?.id, activeId, conversation.messages]
  );
  const readParentReport = useCallback(
    (reportId: string) => {
      // The conversation is hidden while the window is filled, so reading it leaves fill window.
      fillWindow.setOn(false);
      setDockOpen(true);
      setConversationRequest(request => request + 1);
      // After the dock is shown again, or a hidden dock would scroll nothing into view.
      window.requestAnimationFrame(() => {
        const reply = reportReply(threadHost.current, reportId);
        if (!reply) return;
        reply.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        reply.setAttribute('data-report-highlight', '');
        window.setTimeout(() => reply.removeAttribute('data-report-highlight'), REPORT_HIGHLIGHT_MS);
      });
    },
    [setDockOpen, fillWindow.setOn]
  );
  const focusParentChat = useCallback(() => {
    fillWindow.setOn(false);
    setDockOpen(true);
    setConversationRequest(request => request + 1);
    setComposerFocus(request => request + 1);
  }, [setDockOpen, fillWindow.setOn]);

  // The ambient Tavern: after a quiet spell the dock and composer settle out and leave the scene.
  const ambient = useAmbientSettle({
    enabled:
      orchestratorPrefs.ambient &&
      orchestrating &&
      activeId !== null &&
      ORCHESTRATOR_VIEW_INFO[orchestratorView].ambient &&
      !orchestratorSplit &&
      !orchestratorPrefs.focus &&
      !fillWindow.on &&
      introPhase !== 'playing',
    // A reply streaming in is something to watch arrive, not to hide.
    held: () => conversation.streaming || ambientHeld(document),
    onSettledKey: event => {
      if (!isPrintableKey(event) || isEditable(event.target) || inSceneDialogue(event.target)) return;
      event.preventDefault();
      focusParentChat();
    },
  });
  const [ambientHint, setAmbientHint] = useState(false);
  useEffect(() => {
    if (!ambient.settled) {
      setAmbientHint(false);
      return;
    }
    if (readAmbientHintSeen()) return;
    writeAmbientHintSeen();
    setAmbientHint(true);
  }, [ambient.settled]);
  const { wake: wakeAmbient } = ambient;
  const stageAmbient = useMemo<StageAmbient>(
    () => ({
      settled: ambient.settled,
      wake: wakeAmbient,
      on: orchestratorPrefs.ambient,
      onToggle: orchestratorPrefs.setAmbient,
    }),
    [ambient.settled, wakeAmbient, orchestratorPrefs.ambient, orchestratorPrefs.setAmbient]
  );
  const stageFocus = useMemo(
    () => ({ on: orchestratorPrefs.focus, onToggle: orchestratorPrefs.setFocus }),
    [orchestratorPrefs.focus, orchestratorPrefs.setFocus]
  );
  const stagePresenter = useMemo(
    () => ({ on: orchestratorPrefs.presenter, onToggle: orchestratorPrefs.setPresenter }),
    [orchestratorPrefs.presenter, orchestratorPrefs.setPresenter]
  );

  const parentReply = useMemo(() => {
    if (conversation.session?.id !== activeId) return undefined;
    const message = latestReply(conversation.messages, turnOpen);
    const snippet = message ? snippetOf(plainText(closingText(message))) : '';
    return message && snippet ? { id: message.id, snippet } : undefined;
  }, [conversation.session?.id, activeId, conversation.messages, turnOpen]);
  const { send: sendToConversation } = conversation;
  const conversationId = conversation.session?.id;
  const modelSessionId = modelEngine.sessionId;
  // Point-and-edit from the model pane, straight to its conversation like the innkeeper desk below.
  const sendModelEdit = useCallback(
    async (edit: PartEditTurn): Promise<boolean> => {
      if (!modelSessionId || modelSessionId !== conversationId) return false;
      // Decided before sending, as the composer does: a refused send hands its text back to the
      // composer, so retrying without the image would leave it there as well.
      const readsImages = modelOption?.supportsVision !== false;
      const closeup =
        edit.closeup && readsImages
          ? (
              await window.b4m.chat.addAttachments(modelSessionId, [
                { source: 'bytes', name: edit.closeup.name, mediaType: 'image/png', data: edit.closeup.bytes },
              ])
            ).attachments
          : [];
      return sendToConversation(edit.text, closeup, [edit.note(closeup.length > 0)]);
    },
    [sendToConversation, modelSessionId, conversationId, modelOption]
  );
  const dockVisible = orchestratorPrefs.dockOpen && !ambient.settled && !fillWindow.on;
  useEffect(() => {
    if (!persistedId || screen !== 'conversation' || (orchestrating && !dockVisible)) return;
    const acknowledge = () => markSessionViewed(persistedId);
    acknowledge();
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => {
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
    };
  }, [persistedId, screen, unreadReply, orchestrating, dockVisible]);
  const toggleParentChat = () => {
    const agentDetailsOpen = threadHost.current?.parentElement?.querySelector('[data-agent-details-open="true"]');
    wakeAmbient();
    if (!dockVisible || agentDetailsOpen) focusParentChat();
    else closeDock();
  };
  const innkeeperDesk = useMemo<InnkeeperDesk>(
    () => ({
      reply: parentReply,
      onReadReply: id => {
        wakeAmbient();
        readParentReport(id);
      },
      conversationHidden: !dockVisible,
    }),
    [parentReply, wakeAmbient, readParentReport, dockVisible]
  );
  // The agent a clicked needs-you notice asked for; handed to its parent's stage once that is open.
  // Distinct from selectedAgentId below, which is the standing selection the stage and sidebar share.
  const [agentFocus, setAgentFocus] = useState<{ rootId: string; agentId: string } | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const rosterIds = useMemo(() => descendantIds(sessions, activeId), [sessions, activeId]);
  const viewerVisible = screen === 'conversation' && orchestrating && activeId !== null;
  const selectionHost = viewerVisible ? activeId : null;
  const [previousSelectionHost, setPreviousSelectionHost] = useState(selectionHost);
  if (selectionHost !== previousSelectionHost) {
    setPreviousSelectionHost(selectionHost);
    setSelectedAgentId(null);
  }
  const selectedRosterId = viewerVisible && selectedAgentId && rosterIds.has(selectedAgentId) ? selectedAgentId : null;
  const selectSidebarSession = useCallback(
    (sessionId: string) => {
      if (viewerVisible && rosterIds.has(sessionId)) {
        wakeAmbient();
        setSelectedAgentId(sessionId);
        markSessionViewed(sessionId);
      } else {
        setSelectedAgentId(null);
        selectSession(sessionId);
      }
    },
    [viewerVisible, rosterIds, wakeAmbient, selectSession]
  );
  const openNotice = ({ sessionId, rootId }: AttentionOpenEvent) => {
    // A notice outlives its session in the OS notification centre; a deleted one has nothing to open.
    if (!sessions.some(session => session.id === rootId)) return;
    // The session itself asking keeps whichever view it was on; only an agent's notice opens the stage.
    if (sessionId !== rootId) {
      if (rootId === activeId) setOrchestratorSurface('orchestrate');
      else writeSurface(rootId, 'orchestrate');
    }
    selectSession(rootId);
    if (sessionId !== rootId) setAgentFocus({ rootId, agentId: sessionId });
    // The dock is a global preference, so a plain session's notice must not reopen one the user hid.
    else if (alertableSessions(sessions, 'agents').has(rootId)) setDockOpen(true);
  };
  // Only the conversation screen shows the session asking; Artifacts, Models and the rest hide it.
  useNeedsYouAlerts(
    sessions,
    statuses,
    statusesLoaded,
    openNotice,
    screen === 'conversation' ? activeId : null,
    unreadReplies
  );
  const clearAgentFocus = useCallback(() => setAgentFocus(null), []);
  const pickExampleQuest = useCallback(
    (prompt: string) => {
      // The conversation the quest starts plays out in the dock, so a collapsed one would hide the reply.
      setDockOpen(true);
      fillComposer(prompt);
    },
    [setDockOpen, fillComposer]
  );
  const changeOrchestratorLayout = useCallback(
    (layout: OrchestratorLayout) => {
      setIntroPhase('off');
      setOrchestratorLayout(layout);
    },
    [setOrchestratorLayout]
  );
  const missionControl = useMissionControlActions({
    activeId,
    activeHasAgents: hasAgents,
    layout: orchestratorPrefs.layout,
    onLayoutChange: changeOrchestratorLayout,
    setActiveSurface: setOrchestratorSurface,
    selectSession,
  });

  const agentActions = useMemo<AgentActions>(
    () => ({
      open: selectSession,
      stop: sessionId => hostChat.stopReply(sessionId),
      archive: sessionId => {
        const session = sessions.find(candidate => candidate.id === sessionId);
        if (session) void toggleArchived(session);
      },
    }),
    [selectSession, sessions, toggleArchived]
  );
  const paneSessions = useMemo(
    () => ({ sessions, statuses, prSummaries, preparing }),
    [sessions, statuses, prSummaries, preparing]
  );
  const initialCodeSetup = conversation.session?.mode === 'code' && conversation.messages.length === 0;

  /**
   * The session panel: a Code session with a folder after its first message. Until then the same
   * controls are centered in the empty transcript. A loop also makes the panel available in Chat.
   *
   * Docked (`beside` or `push`, see sessionPanelLayout) while the region has room, and then its open
   * flag is remembered; on a narrower region it folds into the header button and opens as an overlay,
   * which is never left open across conversations, launches or a resize.
   */
  const panelProject =
    !opening && !initialCodeSetup && conversation.session?.mode === 'code' ? conversation.session.project : undefined;
  const panelAvailable = !!panelProject || (!opening && !!loop);
  const orchestratorShown = orchestrating && activeId !== null;
  const panelLayout = sessionPanelLayout(threadRegionWidth, { centeredColumn: !orchestratorShown });
  const panelDocked = panelLayout !== 'overlay';
  const panelShown = panelAvailable && (panelDocked ? panelPrefs.open : panelPopoverOpen);
  const panelDrawn = panelShown && !fillWindow.on;
  const panelSpace = panelDrawn && panelLayout === 'push' ? SESSION_PANEL_SPACE : 0;
  // Unmeasured reads as too narrow, the reverse of the panel: a rail drawn before the width is
  // known could overhang the sidebar for a frame, where the footer it falls back to cannot.
  // A pushing panel's reserved space narrows the scroller; the orchestrator's thread dock is narrower still.
  const statsRailFits =
    !orchestratorShown && railFitsBesideThread(threadRegionWidth === null ? null : threadRegionWidth - panelSpace);
  const statsRailOn = useReplyStatsPrefs().rail;
  const bindingErrorHidden =
    !!panelProject && !!conversation.project.error && (!panelShown || panelPrefs.collapsed.has('environment'));
  const { toggleOpen: togglePanelOpen } = panelPrefs;
  const togglePanel = useCallback(() => {
    if (panelDocked) togglePanelOpen();
    else setPanelPopoverOpen(current => !current);
  }, [panelDocked, togglePanelOpen]);
  const closePanelPopover = useCallback(() => setPanelPopoverOpen(false), []);
  useEffect(() => setPanelPopoverOpen(false), [activeId, panelDocked, screen]);

  const settledReply = useMemo(() => latestReply(conversation.messages), [conversation.messages]);
  const hasReply = settledReply !== null;
  const promptCache = settledReply?.promptCache;
  const composerUsage: ComposerUsage = useMemo(() => {
    const reply = latestReply(conversation.messages, turnOpen);
    // The figure ChatService.autoCompact decides on, so red means the same thing on both sides.
    const local = !!conversation.session?.model && isLocalModel(conversation.session.model);
    const snapshot =
      reply?.contextSnapshot && reply.contextSnapshot.model === conversation.session?.model
        ? reply.contextSnapshot
        : null;
    const modelWindow = (local ? snapshot?.modelWindow : modelOption?.contextWindow) ?? null;
    return {
      contextTokens:
        reply?.contextSnapshot && reply.contextSnapshot.model !== conversation.session?.model
          ? null
          : occupiedTokens(conversation.messages, turnOpen, local),
      contextSnapshot: snapshot,
      contextLimit: modelWindow ? effectiveContextLimit(modelWindow) : null,
      modelWindow,
      credits: credits.balance,
      monthlyAllowance: credits.monthlyAllowance,
      ...(credits.error ? { creditsError: credits.error } : {}),
      lastTurn: reply?.usage ?? null,
    };
  }, [
    conversation.messages,
    conversation.session?.model,
    turnOpen,
    modelOption?.contextWindow,
    credits.balance,
    credits.monthlyAllowance,
    credits.error,
  ]);

  // What the turn in flight is doing, read off the reply being streamed into the thread. Only
  // the last message can be that reply, so nothing earlier is consulted.
  const inFlight = conversation.messages[conversation.messages.length - 1];
  const liveText = inFlight ? (roundsOf(inFlight).at(-1)?.text ?? '') : '';
  // The same parse the thread draws from, which is what lets the line speak for the two things
  // the thread leaves out: the code presentReply hides, and the reasoning it never draws.
  const activity = describeActivity(
    inFlight?.toolCalls ?? [],
    writingProse(inFlight),
    presentReply(liveText, true).pending,
    conversation.turn?.reasoning,
    conversation.phase
  );

  /**
   * What the composer says while it will not take a keystroke. It has to name the step that is
   * actually open: there is no conversation to "pick" on a fresh install, so the old copy sent
   * the user looking for a list that says "No Code sessions yet." The button in the empty pane
   * is the step, and this points at it.
   */
  const disabledPlaceholder = settling
    ? ''
    : openFailed
      ? 'This conversation could not be opened'
      : creatingCode
        ? 'Starting a session...'
        : mode === 'code'
          ? 'Start a Code session to type here'
          : 'Start a conversation to type here';

  const setQuote = useCallback((sessionId: string, quote: string | null) => {
    setQuotes(current => {
      const { [sessionId]: _dropped, ...rest } = current;
      return quote ? { ...rest, [sessionId]: quote } : rest;
    });
  }, []);

  const onReplyToSelection = useCallback(
    (text: string) => {
      if (!activeId) return;
      setQuote(activeId, clampQuote(text));
      setComposerFocus(request => request + 1);
    },
    [activeId, setQuote]
  );

  const onSideChatFromSelection = useCallback(
    async (text: string) => {
      if (!activeId) return;
      const origin = activeId;
      setSideChatError(null);
      const result = await window.b4m.chat.startSideChat({ sessionId: activeId, selection: text });
      if (activeIdRef.current !== origin) return;
      if (!result.ok) {
        setSideChatError({ sessionId: activeId, error: result.error });
        return;
      }
      // Reread before opening it: the shell reselects away from an open session the list lacks.
      await reload();
      if (activeIdRef.current !== origin) return;
      if (isSessionPlace(result.session.mode)) setMode(result.session.mode);
      setScreen('conversation');
      setActiveId(result.session.id);
      setComposerFocus(request => request + 1);
    },
    [activeId, reload]
  );

  const onSend = useCallback(
    async (typed: string) => {
      const quote = activeId ? quotes[activeId] : undefined;
      const text = quote ? quotedMessage(quote, typed) : typed;
      if (activeId && quote) setQuote(activeId, null);
      const attached = draft.attachments;
      // Cleared before the await so the row does not sit under the composer while the turn is
      // accepted; a rejected turn restores its text (see useConversation.send) but not its
      // attachments.
      if (!draftActive) draft.clear();
      const accepted = await conversation.send(text, attached);
      if (!accepted && draftActive && activeIdRef.current === activeId) fillComposer(typed);
      // Main knows something this window did not: reread so the banner and Send gate catch up.
      if (!accepted && localMode) void catalog.reload();
    },
    [activeId, quotes, setQuote, conversation, draft, localMode, catalog, draftActive, fillComposer]
  );

  /**
   * Re-read the session list whenever the set of busy sessions changes.
   *
   * The agent can now CREATE conversations, and it does so in main with no IPC call from here
   * to hang a refresh off. A spawned session starts replying the moment it exists, so its
   * status push is the first thing this window hears about it - and without this the row would
   * not appear until something else happened to reload the list.
   */
  useEffect(() => {
    void reload();
  }, [reload, statuses]);

  // Open the most recent conversation of the current mode, so the app lands somewhere useful
  // rather than on an empty pane and switching mode does not leave a session open that the
  // sidebar no longer lists. Only reselects when the open one is not in this mode; past that,
  // the user's choice stands.
  useEffect(() => {
    if (settling) return;
    if (draftActive && sessionDraft.session?.mode === mode && screen === 'conversation') return;
    const open = sessions.find(session => session.id === activeId);
    if (open?.mode === mode) return;
    // A live Claude Code CLI session is always the newest import; landing on it would select a
    // row hidden in the shut "Imported from Claude" section instead of the user's own work.
    const candidate = (session: ChatSessionSummary) =>
      session.mode === mode && (importedInline || !isUntouchedImport(session));
    setActiveId(sessions.find(candidate)?.id ?? null);
  }, [settling, activeId, sessions, mode, importedInline, draftActive, sessionDraft.session?.mode, screen]);

  // The last session open in each session place, so returning to Chat or Code lands where the
  // user left it rather than on the most recent row. Stored with the place itself; see places.ts.
  const placeItems = useRef<{ chat?: string; code?: string }>({ chat: placeMemory?.chat, code: placeMemory?.code });
  const activeSessionMode = sessions.find(session => session.id === activeId)?.mode;
  useEffect(() => {
    if (activeId && activeSessionMode && isSessionPlace(activeSessionMode))
      placeItems.current[activeSessionMode] = activeId;
    writePlaceMemory({
      place,
      ...placeItems.current,
      studio: studioArea,
      ...(studioSession.sessionId ? { studioSession: studioSession.sessionId } : {}),
    });
  }, [place, activeId, activeSessionMode, studioArea, studioSession.sessionId]);

  const selectPlace = useCallback(
    (next: Place) => {
      setScreen('conversation');
      setPlace(next);
      if (!isSessionPlace(next)) return;
      setModeOnly(next);
      if (activeSessionMode === next) return;
      // Left unset, the reselect effect above opens the place's most recent session instead.
      const rememberedId = placeItems.current[next];
      const target = sessions.find(
        session => session.id === rememberedId && session.mode === next && !session.archived
      );
      if (target) setActiveId(target.id);
    },
    [sessions, activeSessionMode]
  );
  usePlaceShortcuts({ onPlace: selectPlace, onToggleSidebar: () => setCollapsed(current => !current) });

  /**
   * A rail click also drives the sidebar, so a collapsed one is always a click away: any icon
   * reopens it, and the active place's icon hides it again. The digit shortcuts only switch place.
   */
  const selectPlaceFromRail = (next: Place) => {
    if (!placeHasSidebar(next)) {
      selectPlace(next);
      return;
    }
    if (collapsed) {
      setCollapsed(false);
      selectPlace(next);
      return;
    }
    if (next === place && screen === 'conversation') {
      setCollapsed(true);
      return;
    }
    selectPlace(next);
  };
  const customizeAttention = useCustomizeAttention();

  /** First-run and explicit New share the renderer-only draft lifecycle. */
  const startSession = useCallback(
    (placement?: SessionPlacement) => {
      clearCodeError();
      return sessionDraft.start(mode, {}, placement);
    },
    [mode, sessionDraft.start, clearCodeError]
  );

  /**
   * New, from the sidebar: it makes a session, opens it, and opens nothing else.
   *
   * It deliberately does not follow the open session into its section. What it makes would then
   * depend on which row happens to be selected, which nothing on the button shows, and a user
   * who wanted a loose session would have to move it back out.
   */
  const onCreate = useCallback(() => {
    setScreen('conversation');
    markSessionStart('new');
    const created = startSession();
    if (created) setActiveId(created);
    setComposerFocus(request => request + 1);
  }, [startSession, markSessionStart]);
  // The app menu's New Chat (Cmd+N), once the last conversation is restored.
  useNewChatRequests(onCreate, !settling);

  const shareFolderTo = conversation.addContextDirectoryTo;
  const addingFolder = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const shareInto = useCallback(async (chatId: string, share: () => Promise<string | undefined>) => {
    try {
      const warning = await share();
      if (warning) setAddFolderAlerts(current => ({ ...current, [chatId]: { text: warning, color: 'warning' } }));
    } catch (error) {
      setAddFolderAlerts(current => ({
        ...current,
        [chatId]: failure('Desktop could not share the folder, so the folder was not added', error),
      }));
    }
  }, []);
  const addFolder = useCallback(async () => {
    clearAddFolderAlert(activeId ?? NO_CHAT);
    if (draftActive) {
      await conversation.project.addContextDirectory();
      return;
    }
    if (activeId) {
      await shareInto(activeId, () => shareFolderTo(activeId));
      return;
    }
    if (addingFolder.current) return;
    addingFolder.current = true;
    try {
      const path = await window.b4m.chat.pickProjectDirectory();
      if (!path || modeRef.current !== 'chat' || activeIdRef.current) return;
      setActiveId(sessionDraft.start('chat'));
      await sessionDraft.share(path);
    } catch (error) {
      if (activeIdRef.current || modeRef.current !== 'chat') return;
      setAddFolderAlerts(current => ({
        ...current,
        [NO_CHAT]: failure('Desktop could not add the folder', error),
      }));
    } finally {
      addingFolder.current = false;
    }
  }, [
    activeId,
    shareFolderTo,
    shareInto,
    clearAddFolderAlert,
    draftActive,
    conversation.project,
    sessionDraft.start,
    sessionDraft.share,
  ]);
  // A failure from before any chat existed retires when a chat opens or the mode switches; the rest stay with their chat.
  useEffect(() => {
    clearAddFolderAlert(NO_CHAT);
  }, [mode, clearAddFolderAlert]);
  useEffect(() => {
    if (activeId) clearAddFolderAlert(NO_CHAT);
  }, [activeId, clearAddFolderAlert]);
  const addFolderAlert = addFolderAlerts[activeId ?? NO_CHAT];

  /** "Use in chat" on the Models screen: a new Chat conversation already on that model. */
  const [chatOnError, setChatOnError] = useState<string | null>(null);
  useEffect(() => {
    if (screen !== 'models') setChatOnError(null);
  }, [screen]);
  const startingChatOn = useRef(false);
  const startChatOn = useCallback(
    async (modelId: string) => {
      if (startingChatOn.current) return;
      startingChatOn.current = true;
      setChatOnError(null);
      try {
        markSessionStart('new');
        const created = sessionDraft.start('chat');
        await sessionDraft.patch({ model: modelId });
        setMode('chat');
        setActiveId(created);
        setScreen('conversation');
      } catch (error) {
        setChatOnError(
          `Desktop could not start a conversation: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        startingChatOn.current = false;
      }
    },
    [sessionDraft.start, sessionDraft.patch, markSessionStart]
  );
  /** The catalog's own entry for an installed model, so the conversation routes to the server it runs on. */
  const modelWith = useCallback(
    (serverId: string, name: string) => {
      const wanted = name.toLowerCase();
      return (
        catalog.models.find(
          model =>
            isLocalBackend(model) &&
            (!model.unavailable || model.pending) &&
            (model.server?.id ?? LOCAL_SERVER_ID) === serverId &&
            model.name.toLowerCase() === wanted
        ) ?? null
      );
    },
    [catalog.models]
  );
  const chatWith = useCallback(
    (serverId: string, name: string) => {
      const option = modelWith(serverId, name);
      return option ? () => void startChatOn(option.id) : null;
    },
    [modelWith, startChatOn]
  );

  /**
   * New, from a user section's header or menu: the same session New makes, but in that section
   * from the moment main mints its id - see CreateSessionRequest.
   */
  const onCreateInSection = useCallback(
    (sectionId: string) => {
      setScreen('conversation');
      const created = startSession({
        sectionId,
        placed: adoptSections,
        failed: reportPlacementFailure,
      });
      if (created) setActiveId(created);
    },
    [startSession, adoptSections, reportPlacementFailure]
  );

  /** Seed a usable draft once per mode, never a persisted sidebar row. */
  const arrived = useRef(new Set<ChatSessionMode>());
  useEffect(() => {
    const empty = !sessions.some(session => session.mode === mode);
    if (!seedOnArrival(arrived.current, { loading: settling, mode, hasSessionInMode: !empty })) return;
    if (!activeId && screen === 'conversation') setActiveId(sessionDraft.start(mode));
  }, [settling, sessions, mode, activeId, screen, sessionDraft.start]);

  /**
   * Another session in the same project, from the group header's "+".
   *
   * The folder is what defines the group, so it carries across and the dialog stays shut.
   * Nothing else does - see newSessionInProject for why the branch is left for the user to
   * pick on the new session. The worktree toggle follows the user's default, and git is only
   * asked whether the folder can hold one when that default is on.
   */
  const onCreateInProject = useCallback(
    async (directory: string) => {
      const sibling = projectForGroup(sessions, directory);
      if (!sibling) return;
      clearCodeError();
      markSessionStart('project');
      // Before the screen switches, so the git calls never leave the previous session's
      // composer live under the new one's id.
      const inWorktree = worktreeByDefault() && canHoldWorktree(await hostChat.inspectProject(sibling.directory));
      setScreen('conversation');
      setMode('code');
      setActiveId(sessionDraft.start('code', newSessionInProject(sibling, inWorktree)));
      setComposerFocus(request => request + 1);
    },
    [sessions, sessionDraft.start, clearCodeError, markSessionStart]
  );

  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const deleteTarget = useMemo(
    () => (deleteSessionId ? sessions.find(session => session.id === deleteSessionId) : undefined),
    [sessions, deleteSessionId]
  );
  const deleteNested = useMemo(
    () => (deleteSessionId ? nestedSessionsOf(sessions, deleteSessionId) : []),
    [sessions, deleteSessionId]
  );
  const onDelete = useCallback(
    async (
      sessionId: string,
      removeWorktree: boolean,
      nestedIds: readonly string[] = [],
      nestedWorktreeIds: readonly string[] = []
    ) => {
      const settle = (ids: readonly string[]) => {
        for (const id of ids) {
          clearAddFolderAlert(id);
          clearDefaultsReadFailure(id);
        }
        setActiveId(current => (current && ids.includes(current) ? null : current));
      };
      try {
        settle(await remove(sessionId, removeWorktree, nestedIds, nestedWorktreeIds));
      } catch (err) {
        settle((err as { deleted?: string[] }).deleted ?? []);
        throw err;
      }
    },
    [remove, clearAddFolderAlert, clearDefaultsReadFailure]
  );

  const thread = opening ? (
    <Box sx={{ flex: 1 }} data-testid="chat-thread-opening" />
  ) : (
    <VideoJobsContext.Provider value={videoJobs}>
      <WebLinkContext.Provider value={openInBrowserPane}>
        <ArtifactBrowserContext.Provider value={openArtifactInBrowserPane}>
          <SessionOpenerContext.Provider value={selectSession}>
            {/* Keyed so an open menu can never carry an image into another conversation,
            should a switch ever skip the `opening` gate that unmounts this today. */}
            <ImageMenuProvider key={activeId ?? 'none'} onAttach={activeId ? draft.attachImage : undefined}>
              {/* A path not found yet is asked again once a turn settles: replies name files before writing them.
              Keyed like the image menu: its answers and an open menu belong to one conversation's folders. */}
              <FilePathLinkProvider
                key={activeId ?? 'none'}
                sessionId={activeId}
                recheck={conversation.settledTurns}
                showFile={showFile}
                selectionEpoch={fileSelectionEpoch}
                onAttach={activeId ? draft.attachFilePath : undefined}
              >
                <MessageThread
                  // Remounted per conversation, so its window and scroll start over and nothing it
                  // set going outlives the conversation it was for. Prefixed, as the session panel
                  // beside it is: two siblings sharing a key leave one of them mounted in the DOM
                  // after React drops it.
                  key={`thread-${activeId ?? 'none'}`}
                  messages={conversation.messages}
                  findable
                  childSessions={paneSessions}
                  sessionId={activeId}
                  // What stands in for the transcript when there is no session to have one. It is the
                  // only control on screen that starts one from here, so it is a button and not a
                  // sentence pointing at the sidebar: the header above says what the state is, this
                  // says what to do about it, and the composer's placeholder names the same step.
                  noSession={
                    mode === 'code' ? (
                      <Stack spacing={1.5} alignItems="center">
                        <Typography level="body-sm" textColor="text.tertiary" data-testid="chat-thread-no-session">
                          Start a Code session to run a task here.
                        </Typography>
                        <Button
                          size="sm"
                          variant="soft"
                          loading={creatingCode}
                          onClick={() => void onCreate()}
                          data-testid="chat-start-session-btn"
                        >
                          New Code session
                        </Button>
                      </Stack>
                    ) : (
                      <BlankChatGreeting line="Start a conversation to chat, write, or create something new.">
                        <Button
                          size="sm"
                          variant="soft"
                          loading={creatingCode}
                          onClick={() => void onCreate()}
                          sx={{ mt: 2.5 }}
                          data-testid="chat-start-session-btn"
                        >
                          New conversation
                        </Button>
                      </BlankChatGreeting>
                    )
                  }
                  emptySession={
                    initialCodeSetup ? (
                      <Box sx={{ width: '100%', maxWidth: 420, minWidth: 0 }} data-testid="chat-code-workspace-setup">
                        <Typography level="title-sm" sx={{ mb: 1.5 }}>
                          Set up this workspace
                        </Typography>
                        <SessionChips
                          layout="embedded"
                          project={conversation.session?.project ?? null}
                          {...(conversation.session?.grantedDirectories
                            ? { grantedDirectories: conversation.session.grantedDirectories }
                            : {})}
                          binding={conversation.project}
                          settledTurns={conversation.settledTurns}
                          preparing={conversation.preparing !== null}
                        />
                      </Box>
                    ) : blankChatId ? (
                      <BlankChat sessionId={blankChatId} tools={creationTools} onPick={fillComposer} />
                    ) : undefined
                  }
                  // turnOpen, not `streaming`: a turn this window never saw start - after a reload, or
                  // one parked at the approval gate - is still running, and Continue must not be
                  // offered on top of it.
                  streaming={turnOpen}
                  onRespond={conversation.respondToApproval}
                  onMove={background.moveToBackground}
                  onContinue={() => void conversation.continueReply()}
                  onEditMessage={conversation.editMessage}
                  onRegenerate={() => void conversation.regenerate()}
                  onReplyToSelection={onReplyToSelection}
                  onSideChatFromSelection={text => void onSideChatFromSelection(text)}
                  status={conversation.turn && <TurnStatus turn={conversation.turn} activity={activity} />}
                  statsRail={statsRailFits && statsRailOn}
                  liveTurn={conversation.turn}
                  // At the foot of the thread rather than above the composer: a background command is
                  // something this conversation started, so it reads as the last thing that happened
                  // in it. It scrolls with the transcript, which is the trade - the panel is reached
                  // from the bottom of the thread, not from a bar that is always on screen.
                  footer={
                    <>
                      {/* The turn line's own slot only exists once a reply does, and the worktree is
              cut before there is one; this sits where that line will appear. */}
                      {!conversation.turn && conversation.preparing && (
                        <Box data-testid="chat-workspace-status">
                          <TurnStatus
                            turn={{ startedAt: conversation.preparing.since, tokens: null }}
                            activity={{ kind: 'tool', label: workspacePhrase(conversation.preparing) }}
                          />
                        </Box>
                      )}
                      {/* The panel lists these itself while it is on screen. */}
                      {!panelShown && (
                        <BackgroundTaskChip running={background.running} onClick={() => setTasksPanelOpen(true)} />
                      )}
                    </>
                  }
                />
              </FilePathLinkProvider>
            </ImageMenuProvider>
          </SessionOpenerContext.Provider>
        </ArtifactBrowserContext.Provider>
      </WebLinkContext.Provider>
    </VideoJobsContext.Provider>
  );

  const threadDockMode: ThreadDockMode = !orchestratorShown ? 'chat' : dockVisible ? 'docked' : 'hidden';
  const sceneConversation =
    orchestratorShown &&
    !orchestratorPrefs.focus &&
    !orchestratorSplit &&
    ORCHESTRATOR_VIEW_INFO[orchestratorView].group === 'scene';
  const handledConversationClicks = useRef(new WeakSet<Event>());
  useEffect(() => {
    if (!sceneConversation || !dockVisible) return;
    const onClick = (event: MouseEvent) => {
      if (handledConversationClicks.current.has(event)) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [role="dialog"]'))
        return;
      closeDock();
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [sceneConversation, dockVisible, closeDock]);

  return (
    <Box
      sx={chatShellRootSx}
      {...drop.handlers}
      data-testid="chat-shell"
      onFocusCapture={event => {
        if (!sceneConversation || !(event.target instanceof Element)) return;
        if (!event.target.matches('[data-testid="chat-composer-input"]')) return;
        wakeAmbient();
        setDockOpen(true);
        setConversationRequest(request => request + 1);
      }}
      onClickCapture={event => {
        handledConversationClicks.current.add(event.nativeEvent);
        if (!sceneConversation || !dockVisible || !(event.target instanceof Element)) return;
        if (!event.currentTarget.contains(event.target)) return;
        if (threadHost.current?.contains(event.target)) return;
        if (event.target.closest('[data-conversation-toggle]')) return;
        // Fill window hides the dock and Exit brings it back as it was, so neither click closes it.
        if (event.target.closest('[data-fill-window-toggle]')) return;
        if (event.target.closest('[data-testid="chat-composer-input"]')) return;
        closeDock();
      }}
    >
      <SpawnFailureToast />
      {deleteSessionId && (
        <DeleteSessionDialog
          key={deleteSessionId}
          sessionId={deleteSessionId}
          title={deleteTarget?.title ?? ''}
          nested={deleteNested}
          onDelete={onDelete}
          onClose={() => setDeleteSessionId(null)}
        />
      )}
      {drop.over && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 'modal',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'background.backdrop',
            border: '2px dashed',
            borderColor: 'primary.outlinedBorder',
            // The overlay must not eat the drop it is announcing; the handlers are on the
            // element underneath it.
            pointerEvents: 'none',
          }}
          data-testid="chat-drop-overlay"
        >
          <Typography level="title-md">Drop to attach</Typography>
        </Box>
      )}

      {/* Hidden rather than unmounted in Fill window, so the sidebar keeps its scroll and search. */}
      <Box data-testid="chat-shell-navigation" sx={{ display: fillWindow.on ? 'none' : 'contents' }}>
        <PlaceRail
          place={place}
          sidebarCollapsed={collapsed}
          onSelect={selectPlaceFromRail}
          needsYou={needsYou}
          account={account?.({
            status: (
              <TurnDot
                state={turnState({ streaming: turnOpen, disabled: !activeId || creatingCode, notReady: unbound })}
              />
            ),
            spentAt: conversation.settledTurns,
            customizeAttention,
            onOpenCustomize: () => setScreen('customize'),
            onOpenModels: () => setScreen('models'),
          })}
        />

        {/* Studio, like web's, carries its own areas and medium rail in the main pane: it has no sidebar. */}
        {inStudio ? null : inLibrary ? (
          !collapsed && (
            <LibrarySidebar
              width={readSidebarWidth()}
              filter={libraryFilter}
              onSelectFilter={filter => {
                setScreen('conversation');
                setLibraryFilter(filter);
              }}
              onToggleCollapsed={() => setCollapsed(current => !current)}
            />
          )
        ) : inAgents ? null : (
          <SessionList
            sessions={sessions}
            mode={mode}
            loading={loading}
            paging={sessionPaging}
            searchSessions={searchSessions}
            activeId={selectedRosterId ?? activeId}
            statuses={statuses}
            prSummaries={prSummaries}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed(current => !current)}
            onSelect={selectSidebarSession}
            onCreate={() => void onCreate()}
            onOpenArtifacts={() => setScreen('artifacts')}
            onOpenMissionControl={() => setScreen('mission-control')}
            onCreateInProject={directory => void onCreateInProject(directory)}
            onCreateInSection={sectionId => void onCreateInSection(sectionId)}
            onDelete={setDeleteSessionId}
            onTogglePin={session => void togglePin(session)}
            onSetOrchestratorLabel={(session, label) => void setOrchestratorLabel(session, label)}
            onToggleArchived={session => void toggleArchived(session)}
            onRename={(session, title) => void rename(session, title)}
            onDownload={session => void exportSession(session)}
            downloadError={exportError}
            onDismissDownloadError={clearExportError}
            renameError={renameError}
            onDismissRenameError={clearRenameError}
            userSections={userSections}
            sectionActions={sectionActions}
            sectionError={sectionError}
            onDismissSectionError={dismissSectionError}
            syncHints={
              onOpenImportSettings
                ? (empty, fallback) => (
                    <SidebarSyncHints
                      empty={empty}
                      fallback={fallback}
                      showWebSync={mode === 'chat'}
                      onOpenSettings={onOpenImportSettings}
                    />
                  )
                : undefined
            }
          />
        )}
      </Box>

      {screen !== 'conversation' && updateNotice}
      {screen === 'artifacts' ? (
        <ArtifactLibraryPanel onClose={() => setScreen('conversation')} />
      ) : screen === 'mission-control' ? (
        <MissionControl
          sessions={sessions}
          statuses={statuses}
          presenting={orchestratorPrefs.presenter}
          onOpen={missionControl.open}
          onOpenBeside={missionControl.openBeside}
          onClose={() => setScreen('conversation')}
        />
      ) : screen === 'models' ? (
        <ModelsScreen
          onClose={() => {
            setChatOnError(null);
            setScreen('conversation');
          }}
          inUse={modelsInUse}
          onOpenModelServers={onOpenModelServers}
          chatWith={chatWith}
          modelWith={modelWith}
          catalog={catalog}
          chatError={chatOnError}
          onDismissChatError={() => setChatOnError(null)}
        />
      ) : screen === 'skill-market' ? (
        <SkillMarketPanel initial={marketListing} onClose={() => setScreen('customize')} />
      ) : screen === 'customize' ? (
        <CustomizeScreen
          sessionId={activeId}
          onClose={() => setScreen('conversation')}
          onOpenSkillMarket={openSkillMarket}
        />
      ) : inStudio ? (
        <StudioMain
          area={studioArea}
          onAreaChange={setStudioArea}
          kind={studioKind}
          onKindChange={setStudioKind}
          controller={studio && studio.sessionId === studioSession.sessionId ? studio : undefined}
          ready={!!studioSession.sessionId}
          unavailableReason={studioPlaceReason}
          productions={<StudioProductions />}
          library={
            <LibraryMain
              filter="all"
              accountKey={studioAccountKey}
              api={window.b4m.library}
              onOpenSession={selectSession}
              onOpenStudio={() => setStudioArea('create')}
            />
          }
        />
      ) : inAgents ? (
        <AgentsPlace groups={board} onOpen={selectSession} onOpenMissionControl={() => setScreen('mission-control')} />
      ) : inLibrary ? (
        <LibraryMain
          filter={libraryFilter}
          accountKey={studioAccountKey}
          api={window.b4m.library}
          onOpenSession={selectSession}
          onOpenStudio={() => selectPlace('studio')}
        />
      ) : (
        <Box
          ref={setStudioRegion}
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: studioOpen && studioPaneLayout(studioWidth) === 'stacked' ? 'column' : 'row',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <Stack
            ref={conversationColumn}
            data-testid="chat-conversation-column"
            sx={{ flex: 1, minWidth: 0, minHeight: 0, ...columnStackSx, [SESSION_PANEL_SPACE_VAR]: `${panelSpace}px` }}
          >
            <Box
              data-testid="chat-conversation-header"
              sx={{ borderBottom: '1px solid', borderColor: 'divider', display: fillWindow.on ? 'none' : undefined }}
            >
              <Box sx={{ ...contentColumnSx, py: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {conversation.session ? (
                    presentingStage ? (
                      <Typography level="title-sm" noWrap data-testid="chat-session-title">
                        Orchestrator
                      </Typography>
                    ) : (
                      <SessionHeader
                        title={activeSummary?.title ?? conversation.session.title}
                        onRename={title =>
                          void (activeSummary ? rename(activeSummary, title) : conversation.rename(title))
                        }
                      />
                    )
                  ) : opening ? null : (
                    <Typography level="title-sm" textColor="text.tertiary">
                      No conversation open
                    </Typography>
                  )}
                </Box>
                <OrchestrateToggle
                  states={spawnedStates}
                  enabled={agentsSurfaceAvailable}
                  parentNeedsYou={!!activeId && statuses.get(activeId) === 'needs-action'}
                  surface={orchestrating ? 'orchestrate' : 'chat'}
                  onSurfaceChange={orchestratorPrefs.setSurface}
                />
                <Box
                  data-testid="chat-header-tools"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    // Only beside the Chat / Agents switch, which renders nothing when it has nothing to switch.
                    '[data-testid="chat-surface-toggle"] + &': {
                      ml: 0.5,
                      pl: 1,
                      borderLeft: '1px solid',
                      borderColor: 'divider',
                    },
                  }}
                >
                  {loop && (!panelShown || panelPrefs.collapsed.has('background')) && (
                    <Box
                      role="status"
                      data-testid="loop-header-status"
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                    >
                      <Button
                        size="sm"
                        variant="soft"
                        color={loop.phase === 'paused' ? 'warning' : 'neutral'}
                        onClick={() => {
                          if (!panelShown) togglePanel();
                          if (panelPrefs.collapsed.has('background')) panelPrefs.toggleSection('background');
                        }}
                        data-testid="loop-header-open-btn"
                      >
                        Loop {loop.phase}
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        aria-label="Stop loop"
                        data-testid="loop-header-stop-btn"
                        onClick={() => void window.b4m.chat.loopCommand(loop.sessionId, 'stop')}
                      >
                        Stop
                      </Button>
                    </Box>
                  )}
                  {panelAvailable && (
                    <Tooltip
                      size="sm"
                      variant="soft"
                      placement="bottom-end"
                      title={panelShown ? 'Hide the session panel' : 'Show the session panel'}
                    >
                      <IconButton
                        ref={panelToggle}
                        size="sm"
                        variant={panelShown ? 'soft' : 'plain'}
                        color="neutral"
                        aria-expanded={panelShown}
                        aria-controls={panelShown ? SESSION_PANEL_ID : undefined}
                        aria-label={panelShown ? 'Hide the session panel' : 'Show the session panel'}
                        onClick={togglePanel}
                        data-testid="chat-toggle-session-panel-btn"
                      >
                        <PanelRightIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {/* Inside the reading column, not out at the window edge: a popup opening from
                  here cannot reach the pane, and one over the pane would be drawn behind the
                  web page - see agentBrowser.ts. */}
                  <SessionArtifactsButton artifacts={artifactsInSession} onOpen={openSessionArtifact} />
                  <OpenPaneButtons panes={paneControls} focusAfterClose={panesMenuButtonRef} />
                  <PanesMenu
                    buttonRef={panesMenuButtonRef}
                    panes={paneControls}
                    historyOn={!opening && conversation.session?.historyEnabled === true}
                  />
                  {/* Drawn at every width, so the buttons beside it never shift and focus is never
                  dropped as the window crosses the breakpoint; narrower, the tooltip says why
                  nothing shows beside the conversation. */}
                  <Tooltip
                    size="sm"
                    variant="soft"
                    placement="bottom-end"
                    title={replyStatsToggleTitle({
                      persisted: !!persistedId,
                      orchestratorShown,
                      railFits: statsRailFits,
                      railOn: statsRailOn,
                    })}
                  >
                    <Box component="span" sx={{ display: 'inline-flex' }}>
                      <IconButton
                        size="sm"
                        variant={statsRailOn && persistedId ? 'soft' : 'plain'}
                        color="neutral"
                        disabled={!persistedId}
                        aria-pressed={statsRailOn}
                        aria-label={statsRailOn ? 'Hide reply stats' : 'Show reply stats'}
                        onClick={() => setReplyStatsRail(!statsRailOn)}
                        data-testid="chat-toggle-reply-stats-btn"
                      >
                        <StatsIcon />
                      </IconButton>
                    </Box>
                  </Tooltip>
                </Box>
              </Box>
            </Box>

            {/* The region the session panel floats over: the thread and nothing below it, so the
              card can never reach the composer, and everything it does not cover stays live. */}
            <Box
              ref={threadRegion}
              data-testid="chat-update-notice-region"
              sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            >
              {/* One tree for both surfaces, so entering or leaving orchestrate, or toggling the dock,
                never remounts the thread and loses the reader's place in it. */}
              <Box
                data-testid="chat-thread-region"
                sx={{
                  position: 'relative',
                  display: 'flex',
                  flex: 1,
                  minHeight: 0,
                  pr: `${panelSpace}px`,
                  // The row reserves the rail once, including for the orchestrator's narrower dock.
                  [SESSION_PANEL_SPACE_VAR]: '0px',
                  transition: `padding-right ${COLUMN_LAYOUT_TRANSITION}`,
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                  '&:has([data-agent-details-open="true"]) > [data-scene-conversation]': {
                    visibility: 'hidden',
                  },
                }}
              >
                {orchestratorShown && (
                  <OrchestratorSurface
                    // Keyed so a switch between orchestrating parents resets selection and sort, and never reuses sprites.
                    key={activeId}
                    rootId={activeId}
                    sessions={sessions}
                    statuses={statuses}
                    preparing={preparing}
                    background={backgroundJobs}
                    prSummaries={prSummaries}
                    canStartAgents={orchestrateCapable}
                    layout={orchestratorLayout}
                    onLayoutChange={changeOrchestratorLayout}
                    actions={agentActions}
                    onOpenPrLink={(_sessionId, url) => openInBrowserPane(url)}
                    introPlaying={introPhase === 'playing'}
                    renderView={renderOrchestratorView}
                    onParentFocus={focusParentChat}
                    onParentToggle={toggleParentChat}
                    report={parentReport}
                    onReadReport={readParentReport}
                    selection={{ id: selectedRosterId, onChange: setSelectedAgentId }}
                    focusAgent={agentFocus?.rootId === activeId ? agentFocus.agentId : null}
                    onFocusAgentConsumed={clearAgentFocus}
                    onExampleQuest={pickExampleQuest}
                    desk={innkeeperDesk}
                    ambient={stageAmbient}
                    focus={stageFocus}
                    conversationRequest={conversationRequest}
                    presenter={stagePresenter}
                    paneSessions={paneSessions}
                    fillWindow={fillWindow}
                    dockControl={
                      <Tooltip
                        size="sm"
                        variant="soft"
                        placement="bottom-end"
                        title={orchestratorPrefs.dockOpen ? 'Hide the conversation' : 'Show the conversation'}
                      >
                        <IconButton
                          size="sm"
                          variant={orchestratorPrefs.dockOpen ? 'soft' : 'plain'}
                          color="neutral"
                          aria-pressed={orchestratorPrefs.dockOpen}
                          aria-label={orchestratorPrefs.dockOpen ? 'Hide the conversation' : 'Show the conversation'}
                          ref={dockToggle}
                          data-conversation-toggle
                          onClick={() => {
                            if (
                              sceneConversation &&
                              threadHost.current?.parentElement?.querySelector('[data-agent-details-open="true"]')
                            ) {
                              focusParentChat();
                            } else {
                              setDockOpen(!orchestratorPrefs.dockOpen);
                              if (!orchestratorPrefs.dockOpen) setConversationRequest(request => request + 1);
                            }
                          }}
                          data-testid="orchestrator-dock-toggle-btn"
                        >
                          <ConversationIcon />
                        </IconButton>
                      </Tooltip>
                    }
                  />
                )}
                <ThreadDock
                  mode={threadDockMode}
                  hostRef={threadHost}
                  onClose={closeDock}
                  scene={sceneConversation ? { skin: ORCHESTRATOR_VIEW_INFO[orchestratorView].detailsSkin } : undefined}
                >
                  {thread}
                </ThreadDock>
              </Box>

              {panelDrawn && conversation.session && (
                <SessionPanel
                  // Keyed so an action error or an unfolded list does not follow the user to the next
                  // conversation.
                  key={`panel-${activeId ?? 'none'}`}
                  variant={panelDocked ? 'docked' : 'overlay'}
                  collapsed={panelPrefs.collapsed}
                  onToggleSection={panelPrefs.toggleSection}
                  onDismiss={closePanelPopover}
                  anchor={panelToggle}
                  environment={{
                    project: panelProject,
                    ...(conversation.session.grantedDirectories
                      ? { grantedDirectories: conversation.session.grantedDirectories }
                      : {}),
                    binding: conversation.project,
                    settledTurns: conversation.settledTurns,
                    inUse: conversation.messages.length > 0,
                    preparing: conversation.preparing !== null,
                  }}
                  changes={{
                    workspace: workspaceChanges,
                    hasPullRequest,
                    pullRequest,
                    pullRequestActions: {
                      onDismiss: () =>
                        activeId ? window.b4m.pullRequests.dismiss(activeId) : Promise.resolve({ ok: true as const }),
                      onRefresh: () => activeId && void window.b4m.pullRequests.refresh(activeId),
                      onSetOption: (option, enabled) =>
                        activeId
                          ? window.b4m.pullRequests.setOption(activeId, option, enabled)
                          : Promise.resolve({ ok: false as const, error: 'No conversation is open.' }),
                      onOpenLink: openInBrowserPane,
                    },
                    busy: turnOpen,
                    // Straight to the conversation, not through onSend: that one also sends whatever
                    // is attached in the composer, which the user staged for a different message.
                    onCreatePullRequest: changes => void conversation.send(createPullRequestPrompt(changes)),
                  }}
                  context={composerUsage}
                  plan={{ todos: plan, turnOpen }}
                  background={{
                    loop,
                    processes: background.processes,
                    spawned,
                    onStopProcess: background.stop,
                    onStopSession: sessionId => void hostChat.stopReply(sessionId),
                    onOpenSession: selectSession,
                    onShowOutput: () => setTasksPanelOpen(true),
                  }}
                />
              )}
              {/* A modal panel leaves no room for a second card; Home keeps the update controller mounted. */}
              {(!panelShown || panelDocked) && updateNotice}
            </Box>

            {ambient.settled && (
              <Box sx={contentColumnSx}>
                <Box
                  data-testid="orchestrator-ambient-chip-row"
                  sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, py: 1 }}
                >
                  <Button
                    size="sm"
                    variant="soft"
                    color="neutral"
                    onClick={() => {
                      wakeAmbient();
                      focusParentChat();
                    }}
                    data-testid="orchestrator-ambient-talk-btn"
                  >
                    {ambientTalkLabel}
                  </Button>
                  {ambientHint && (
                    <Typography level="body-xs" textColor="text.tertiary" data-testid="orchestrator-ambient-hint">
                      Move the mouse to bring the controls back
                    </Typography>
                  )}
                </Box>
              </Box>
            )}
            {/* Hidden, never unmounted, while the Tavern is quiet or fills the window: the composer keeps its draft. */}
            <Box
              data-testid="chat-composer-region"
              sx={{ display: ambient.settled || fillWindow.on ? 'none' : 'contents' }}
            >
              {!panelShown && <TodoPanel todos={plan} turnOpen={turnOpen} />}

              {/* A compaction is a round trip the user is waiting on, with nothing streaming into the
              thread to show for it. Above the error slot, because a refusal replaces it. */}
              {conversation.commandProgress && (
                <Box sx={contentColumnSx}>
                  <Alert size="sm" color="neutral" variant="soft" data-testid="chat-command-progress">
                    {conversation.commandProgress}
                  </Alert>
                </Box>
              )}

              {conversation.sendError && (
                <Box sx={contentColumnSx}>
                  <Alert size="sm" color="danger" variant="soft" data-testid="chat-send-error">
                    {conversation.sendError}
                  </Alert>
                </Box>
              )}

              {conversation.notice && (
                <Box sx={contentColumnSx}>
                  <Alert
                    size="sm"
                    color="warning"
                    variant="soft"
                    sx={{ cursor: 'pointer', whiteSpace: 'pre-line' }}
                    onClick={conversation.dismissNotice}
                    data-testid="chat-notice"
                  >
                    {conversation.notice}
                  </Alert>
                </Box>
              )}

              {addFolderAlert && (
                <Box sx={contentColumnSx}>
                  <Alert
                    size="sm"
                    color={addFolderAlert.color}
                    variant="soft"
                    sx={{ cursor: 'pointer' }}
                    onClick={() => clearAddFolderAlert(activeId ?? NO_CHAT)}
                    data-testid={addFolderAlert.color === 'danger' ? 'chat-add-folder-error' : 'chat-add-folder-notice'}
                  >
                    {addFolderAlert.text}
                  </Alert>
                </Box>
              )}

              {defaultsReadError && defaultsSessionId && (
                <Box sx={contentColumnSx}>
                  <Alert
                    size="sm"
                    color="warning"
                    variant="soft"
                    sx={{ cursor: 'pointer' }}
                    onClick={() => clearDefaultsReadFailure(defaultsSessionId)}
                    data-testid="chat-model-defaults-error"
                  >
                    {defaultsReadError}
                  </Alert>
                </Box>
              )}

              {codeError && (
                <Box sx={contentColumnSx}>
                  <Alert
                    size="sm"
                    color="danger"
                    variant="soft"
                    sx={{ cursor: 'pointer' }}
                    onClick={clearCodeError}
                    data-testid="chat-code-create-error"
                  >
                    {codeError}
                  </Alert>
                </Box>
              )}

              {sideChatError?.sessionId === activeId && (
                <Box sx={contentColumnSx}>
                  <Alert
                    size="sm"
                    color="danger"
                    variant="soft"
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setSideChatError(null)}
                    data-testid="chat-side-chat-error"
                  >
                    {sideChatError.error}
                  </Alert>
                </Box>
              )}

              {presentingStage && (
                <PresenterPendingNotice
                  count={heldRelays.held.length + decisionsFor(persistedId, taskDecisions).length}
                  onTurnOff={() => orchestratorPrefs.setPresenter(false)}
                />
              )}

              {!presentingStage && (
                <>
                  <HeldRelayCard held={heldRelays.held} onResolve={heldRelays.resolve} onOpenSession={selectSession} />

                  <TaskDecisionCards
                    sessionId={persistedId}
                    decisions={
                      agentDecisionsInScene
                        ? taskDecisions.filter(entry => entry.sessionId === persistedId)
                        : taskDecisions
                    }
                    onOpenSession={selectSession}
                  />

                  <SpawnSuggestionTray
                    suggestions={spawnSuggestions.suggestions}
                    onStart={onStartSuggestion}
                    onDismiss={spawnSuggestions.dismiss}
                    onOpenSession={selectSession}
                    location={spawnLocation}
                  />

                  <ChildrenStrip
                    sessions={sessions}
                    statuses={statuses}
                    parentId={persistedId}
                    reportedIds={reportedChildIds}
                    onOpenSession={selectSession}
                  />
                </>
              )}

              {/* After first use, an unbound session or a hidden panel error still needs these controls
            above the composer. Empty Code sessions render them in the transcript instead. */}
              {conversation.session?.mode === 'code' &&
                !initialCodeSetup &&
                (!conversation.session.project || bindingErrorHidden) && (
                  <SessionChips
                    project={conversation.session.project ?? null}
                    {...(conversation.session.grantedDirectories
                      ? { grantedDirectories: conversation.session.grantedDirectories }
                      : {})}
                    binding={conversation.project}
                    settledTurns={conversation.settledTurns}
                    inUse={conversation.messages.length > 0}
                    preparing={conversation.preparing !== null}
                  />
                )}
              {conversation.session && conversation.session.mode !== 'code' && (
                <GrantedFolderChips
                  directories={conversation.session.grantedDirectories ?? []}
                  onRemove={conversation.project.removeContextDirectory}
                />
              )}

              <CacheExpiryNote
                stamp={promptCache}
                model={modelOption}
                contextTokens={composerUsage.contextTokens ?? 0}
                ttl={cacheTtlFor(modelOption)}
                turnOpen={turnOpen}
                sx={contentColumnSx}
              />

              {showExampleQuests && (
                <Box sx={contentColumnSx}>
                  <ExampleQuestStrip onPick={pickExampleQuest} />
                </Box>
              )}

              <Composer
                sessionId={activeId}
                promptHistory={sentPrompts}
                disabled={!activeId || creatingCode || sessionDraft.busy || openFailed}
                disabledPlaceholder={disabledPlaceholder}
                streaming={turnOpen}
                attachments={draft}
                blockedReason={blockedReason}
                blockedAction={blockedAction}
                blockedNotice={blockedNotice}
                // Blocked rather than refused: a refused send has already cleared the box.
                notReady={
                  auth?.reauthRequired && !(conversation.session && isLocalModel(conversation.session.model))
                    ? 'Sign in'
                    : unbound
                      ? 'No folder'
                      : null
                }
                usage={composerUsage}
                contextStatus={
                  <ContextRing
                    tokens={composerUsage.contextSnapshot?.inputTokens ?? composerUsage.contextTokens}
                    limit={composerUsage.contextLimit}
                    modelId={conversation.session?.model ?? null}
                    promptCache={promptCache}
                    streaming={turnOpen}
                    hasReply={hasReply}
                    usage={composerUsage}
                  />
                }
                placeholder={
                  conversation.session?.mode === 'code' ? 'Describe a task or ask a question' : 'Send a message...'
                }
                onSend={text => void onSend(text)}
                onStop={conversation.stop}
                onRunCommand={(name, args) => void conversation.runCommand(name, args)}
                onBrowseSkillMarket={() => openSkillMarket()}
                // A Code session shares folders from its workspace controls instead. Both must say
                // Chat: for a frame after a mode switch, the open session is still the old mode's.
                addFolder={
                  mode === 'chat' && (conversation.session?.mode ?? 'chat') === 'chat'
                    ? { onClick: () => void addFolder(), disabled: opening || openFailed }
                    : null
                }
                sessionMode={conversation.session?.mode ?? 'chat'}
                suggestion={nextPrompt.suggestion}
                onSuggestionDismissed={nextPrompt.dismiss}
                queued={conversation.queued}
                onCancelQueued={conversation.cancelQueued}
                onSendQueuedNow={conversation.sendQueuedNow}
                returned={conversation.returned}
                onReturnedConsumed={conversation.clearReturned}
                fill={composerFill}
                onFillConsumed={clearComposerFill}
                focusRequest={composerFocus}
                quote={activeId ? (quotes[activeId] ?? null) : null}
                onRemoveQuote={() => activeId && setQuote(activeId, null)}
                skills={skills}
                mentionSessions={sessions}
                leading={
                  <>
                    <ApprovalModePill
                      key={`approval:${activeId ?? ''}`}
                      mode={conversation.session?.approvalMode ?? 'ask'}
                      disabled={chatSettingsLocked}
                      onSelect={mode => void conversation.setApprovalMode(mode)}
                    />
                    {orchestrateCapable && (
                      <OrchestratePill
                        on={delegating}
                        disabled={!activeId}
                        policy={conversation.session?.orchestrationPolicy}
                        planner={conversation.session?.model}
                        models={catalog.models}
                        onChange={(on, budgetCredits) => void setOrchestrate(on, budgetCredits)}
                      />
                    )}
                  </>
                }
                footer={indicators => (
                  <TuneTray
                    disabled={!activeId}
                    trailing={
                      <>
                        <ModelPicker
                          key={`model:${activeId ?? ''}`}
                          catalog={catalog}
                          modelId={conversation.session?.model ?? null}
                          disabled={chatSettingsLocked}
                          onSelect={model => void conversation.setModel(model)}
                          noLocal={noLocal}
                          local={localMode}
                          onOpenModels={() => setScreen('models')}
                          switchCredits={model =>
                            modelSwitchCredits(model, composerUsage.contextTokens ?? 0, cacheTtlFor(model))
                          }
                          servers={savedServers}
                          hasHistory={conversation.messages.length > 0}
                          sessionId={activeId}
                        />
                        {indicators}
                      </>
                    }
                  >
                    {compact => (
                      <>
                        <ReasoningEffortPicker
                          key={`effort:${activeId ?? ''}`}
                          models={catalog.models}
                          modelId={conversation.session?.model ?? null}
                          effort={conversation.session?.reasoningEffort ?? 'default'}
                          defaultEffort={defaultEffort}
                          disabled={chatSettingsLocked}
                          compact={compact}
                          onSelect={effort => void conversation.setReasoningEffort(effort)}
                        />
                        {/* One per chat: Mod+1-9 switches chats from inside the dialog, and its edits belong to the old one. */}
                        <GenerationSettingsPicker
                          key={activeId ?? ''}
                          model={modelOption}
                          generation={conversation.session?.generation}
                          modelDefaults={modelDefaults ?? undefined}
                          effort={conversation.session?.reasoningEffort ?? 'default'}
                          disabled={chatSettingsLocked}
                          compact={compact}
                          onChange={conversation.setGeneration}
                        />
                        <PromptCacheTtlPicker
                          key={`cache:${activeId ?? ''}`}
                          model={modelOption}
                          ttl={sessionCacheTtl}
                          contextTokens={composerUsage.contextTokens ?? 0}
                          disabled={chatSettingsLocked}
                          compact={compact}
                          onSelect={ttl => void conversation.setPromptCacheTtl(ttl)}
                        />
                      </>
                    )}
                  </TuneTray>
                )}
              />
            </Box>

            {terminalOpen && activeId && (
              <TerminalPanel
                key={activeId}
                sessionId={activeId}
                column={conversationColumn}
                focusRequest={terminalFocus?.sessionId === activeId ? terminalFocus.seq : 0}
                onHide={hideTerminal}
                onOpenLink={openInBrowserPane}
              />
            )}
          </Stack>
          {studioOpen && (
            <StudioPane
              key={`${studioAccountKey}:${activeId ?? ''}:${studio?.workspaceId ?? ''}`}
              controller={studio?.sessionId === persistedId ? studio : undefined}
              unavailableReason={
                !persistedId ? 'Send a message to start a conversation, then open Studio to create media.' : undefined
              }
              variant={studioPaneLayout(studioWidth)}
              onClose={() => {
                setStudioOpen(false);
                panesMenuButtonRef.current?.focus();
              }}
            />
          )}
        </Box>
      )}

      {/* The third column: a sibling of the conversation in the shell's flex row, not an
        overlay. The conversation keeps `flex: 1, minWidth: 0` and its reading column keeps
        `mx: 'auto'`, so opening this re-centres the transcript and the composer together -
        they share contentColumnSx, and neither one is told the panel exists.

        It is mounted only when there is something to show, so a panel left open never eats
        width on a conversation that has no background commands. */}
      {tasksOpen && background.processes.length > 0 && inSessionPlace && (
        <BackgroundTaskPanel
          processes={background.processes}
          wide={tasksWide}
          onToggleWide={toggleTasksWide}
          onClose={() => setTasksPanelOpen(false)}
          onStop={background.stop}
          onClearFinished={background.clearFinished}
        />
      )}

      {/* macOS only: `available` is false elsewhere, so the pane and its button never draw. */}
      {simulatorOpen && simulatorView.available && screen === 'conversation' && inSessionPlace && (
        <SimulatorPane state={simulatorView} onClose={toggleSimulator} />
      )}

      {openFile && openFile.sessionId === activeId && screen === 'conversation' && inSessionPlace && (
        <FilePane
          key={openFile.sessionId}
          sessionId={openFile.sessionId}
          requested={openFile.requested}
          view={openFile.view}
          // A settled turn may have rewritten the file it is showing.
          refreshKey={conversation.settledTurns}
          conversation={conversationColumn}
          onOpenExternally={openFileExternally}
          onClose={closeFile}
        />
      )}

      {modelOpen && modelAvailable && inSessionPlace && (
        <ModelPane
          engine={modelEngine}
          dark={darkMode}
          onClose={toggleModel}
          onExamplePrompt={fillComposer}
          onSendEdit={sendModelEdit}
          replying={turnOpen && modelSessionId === conversationId}
          conversation={conversationColumn}
        />
      )}

      {/* Last in the row, so the web page is at the window's own right edge.

        Unlike every other column here, what this one reserves is a hole for a NATIVE view the
        main process draws in front of the renderer. It is therefore mounted only on the
        conversation screen - the artifacts and customize screens take the whole pane and a web
        page floating over them would be unreachable - and it is told to stand down while the
        drop overlay is up, which is drawn in the React tree and so would be behind it. */}
      {browserOpen && browserAvailable && screen === 'conversation' && inSessionPlace && (
        <BrowserPane
          sessionId={activeId}
          suspended={drop.over || (panelShown && !panelDocked)}
          conversation={studioContainer}
          historyEnabled={!opening && conversation.session ? conversation.session.historyEnabled === true : null}
          onHistory={onHistory}
          agentTurn={turnOpen}
        />
      )}
    </Box>
  );
}

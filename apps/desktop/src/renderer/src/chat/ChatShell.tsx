import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import type { ChatProject, ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import type { SkillMarketListingRef } from '@shared/skillMarket';
import { isLocalModel, SESSION_TITLE_MAX_LENGTH } from '@shared/chat';
import { effectiveContextLimit } from '@shared/contextLimit';
import { activeTodos } from '@shared/todos';
import { ArtifactLibraryPanel } from './ArtifactLibraryPanel';
import { SkillMarketPanel } from './SkillMarketPanel';
import { BackgroundTaskChip, BackgroundTaskPanel } from './BackgroundTaskPanel';
import { readPanelFlag, spawnedSessions, writePanelFlag } from './backgroundTasks';
import { BrowserPane } from './BrowserPane';
import { readBrowserPaneOpen, writeBrowserPaneOpen } from './agentBrowser';
import { ApprovalModePill } from './ApprovalModePill';
import { Composer } from './Composer';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';
import { GlobeIcon, PanelRightIcon, TerminalIcon } from './icons';
import { MessageThread } from './MessageThread';
import { chatShellRootSx, columnStackSx, contentColumnSx } from './layout';
import { ModelPicker } from './ModelPicker';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { GrantedFolderChips, SessionChips } from './SessionChips';
import { SESSION_PANEL_ID, SessionPanel } from './SessionPanel';
import { panelFitsBesideThread, useElementWidth, useSessionPanelPrefs } from './sessionPanelState';
import { createPullRequestPrompt } from './changesBarModel';
import { useWorkspaceChanges } from './useWorkspaceChanges';
import { openInSessionBrowser } from './prLinks';
import { usePrSummaries, usePullRequest } from './usePullRequest';
import { SessionList } from './SessionList';
import { isUntouchedImport, projectForGroup } from './grouping';
import { useImportedInline } from './importedInline';
import { TerminalPanel } from './TerminalPanel';
import {
  isTerminalToggle,
  readTerminalOpenSessions,
  withTerminalOpen,
  writeTerminalOpenSessions,
} from './terminalPanelState';
import { TodoPanel } from './TodoPanel';
import { SpawnSuggestionTray } from './SpawnSuggestionTray';
import { useSpawnSuggestions } from './useSpawnSuggestions';
import { TurnDot, turnState } from './TurnDot';
import { TurnStatus } from './TurnStatus';
import { workspacePhrase } from './workspaceProgress';
import { canHoldWorktree, worktreeByDefault } from './worktreeDefault';
import { presentReply } from './codeStream';
import { seedOnArrival } from './firstRunSeed';
import { readLastSession, useLastSession } from './lastSession';
import { newSessionInProject } from './newSessionInProject';
import { roundsOf } from './replyRounds';
import { contextTokens, describeActivity, latestReply, writingProse, type ComposerUsage } from './statusLine';
import { useAccountCredits } from './useAccountCredits';
import { ImageMenuProvider } from './ImageContextMenu';
import { toAttachmentInputs, useAttachmentDraft } from './useAttachments';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { useVideoJobs, VideoJobsContext } from './useVideoJobs';
import { WebLinkContext } from './WebResults';
import { useConversation, useModelCatalog, useSessionStatuses, useSessions, type SessionPlacement } from './useChat';
import { useSidebarSections } from './useSidebarSections';
import { usePromptSuggestion } from './usePromptSuggestion';
import { useFileDrop } from './useFileDrop';
import { useSkills } from './useSkills';
import { useSessionStartTiming } from './useSessionStartTiming';
import { SpawnFailureToast } from './SpawnFailureToast';

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
 * The working directory a Code session's commands actually run in, under its title.
 *
 * Only shown when it differs from the project directory, because that difference IS the
 * worktree toggle: the session panel says which branch and that a worktree is on, and this is
 * the one thing it cannot fit - where that resolved to.
 */
function WorkingDirectoryLine({ project }: { project: ChatProject }) {
  if (project.workingDirectory === project.directory) return null;
  return (
    <Tooltip title={project.workingDirectory} size="sm" variant="soft" placement="bottom-start">
      <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="chat-project-cwd">
        worktree: {project.workingDirectory}
      </Typography>
    </Tooltip>
  );
}

/**
 * What the main pane is showing. One value rather than a flag per screen, so the screens
 * cannot both be up and nothing has to remember to shut the other one.
 */
type ChatScreen = 'conversation' | 'artifacts' | 'customize' | 'skill-market';

/**
 * The sidebar's account strip, given the dot that says whether a reply is running.
 *
 * A function rather than a node because the two halves are owned in different places: this
 * component knows the turn state, and the account strip knows where a glyph goes in its own
 * row. Handing the finished dot down keeps both where they belong - see TurnDot.
 */
export type AccountStrip = (status: ReactNode) => ReactNode;

export function ChatShell({ auth, account }: { auth?: AuthState | null; account?: AccountStrip }) {
  const {
    sessions,
    loading,
    reload,
    create,
    createCode,
    creatingCode,
    codeError,
    clearCodeError,
    remove,
    togglePin,
    toggleArchived,
    rename,
    renameError,
    clearRenameError,
    apply,
  } = useSessions();
  const {
    sections: userSections,
    actions: sectionActions,
    adopt: adoptSections,
    placementFailed: reportPlacementFailure,
    error: sectionError,
    dismissError: dismissSectionError,
  } = useSidebarSections();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [remembered] = useState(readLastSession);
  const [mode, setMode] = useState<ChatSessionMode>(remembered?.mode ?? 'chat');
  const onRestore = useCallback((session: ChatSessionSummary | null) => {
    setMode(session?.mode ?? 'chat');
    if (session) setActiveId(session.id);
  }, []);
  const restoring = useLastSession({ remembered, loading, sessions, activeId, onRestore });
  // Until this is false the shell does not know which conversation it will show, so it draws
  // none of the empty-state copy that would otherwise flash up before the real one.
  const settling = loading || restoring;
  const [importedInline] = useImportedInline();

  const conversation = useConversation(activeId, apply);
  // The header follows the sidebar's copy of the title, so a rename from any row - including
  // its optimistic title and any rollback - shows above the thread too.
  const activeSummary = useMemo(() => sessions.find(session => session.id === activeId), [sessions, activeId]);
  // A conversation picked before its transcript has been read would otherwise show the empty
  // thread's "send a message" line for a frame - or, on a switch, the PREVIOUS conversation's
  // transcript under this one's id until the read lands.
  const opening = settling || (!!activeId && conversation.session?.id !== activeId);
  const spawnSuggestions = useSpawnSuggestions(conversation.session);
  const markSessionStart = useSessionStartTiming(sessions);
  const startSuggestion = spawnSuggestions.start;
  const onStartSuggestion = useCallback(
    (request: Parameters<typeof startSuggestion>[0]) => {
      if (request.placement !== 'here') markSessionStart('suggestion');
      return startSuggestion(request);
    },
    [startSuggestion, markSessionStart]
  );
  const background = useBackgroundProcesses(activeId);
  const videoJobs = useVideoJobs(activeId);
  const skills = useSkills(activeId);
  const catalog = useModelCatalog();
  const statuses = useSessionStatuses();
  const prSummaries = usePrSummaries();
  const [collapsed, setCollapsed] = useState(false);
  const [screen, setScreen] = useState<ChatScreen>('conversation');
  // Window chrome, so it is remembered per machine rather than per conversation. Seeded from
  // storage on the first render and written back on every change, which is the whole of the
  // persistence - see backgroundTasks.ts for the keys and the blocked-storage fallback.
  const [tasksOpen, setTasksOpen] = useState(() => readPanelFlag('open'));
  const [tasksWide, setTasksWide] = useState(() => readPanelFlag('wide'));
  const [browserOpen, setBrowserOpen] = useState(() => readBrowserPaneOpen());
  // Per conversation rather than one flag: see terminalPanelState.ts.
  const [terminalSessions, setTerminalSessions] = useState(readTerminalOpenSessions);
  // Which conversation last asked for the keyboard to go to its terminal; see TerminalPanel.
  const [terminalFocus, setTerminalFocus] = useState<{ sessionId: string; seq: number } | null>(null);
  const draft = useAttachmentDraft(activeId);
  const nextPrompt = usePromptSuggestion(activeId);
  // Only the conversation screen counts as showing one: main polls what is on screen faster.
  const pullRequest = usePullRequest(screen === 'conversation' ? activeId : null);
  // What the browser pane trades width with; see BrowserPane.
  const conversationColumn = useRef<HTMLDivElement | null>(null);
  const panelPrefs = useSessionPanelPrefs();
  // The thread region the session panel floats over; its width decides docked or popover.
  const [threadRegion, threadRegionWidth] = useElementWidth<HTMLDivElement>();
  const [panelPopoverOpen, setPanelPopoverOpen] = useState(false);
  const panelToggle = useRef<HTMLButtonElement | null>(null);

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
      if (selected) setMode(selected.mode);
      setScreen('conversation');
      setActiveId(sessionId);
    },
    [sessions]
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
  const openInBrowserPane = useCallback(
    (url: string) => openInSessionBrowser(url, activeId, showBrowserPane),
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
  const modelOption = catalog.models.find(model => model.id === conversation.session?.model);
  const blockedReason =
    modelOption?.supportsVision === false && draft.attachments.some(attachment => attachment.kind === 'image')
      ? `${modelOption.name} cannot read images. Pick a model that can, or remove the image before sending.`
      : null;

  // A Code session with no project has no working directory, so main refuses the turn. The
  // centered workspace form is the thing to act on, and the composer names the state in one word
  // where the reader already looks for "can I send?". Main's refusal stays as the guard.
  const unbound = conversation.session?.mode === 'code' && !conversation.session.project;

  /**
   * Whether this conversation HAS an agent browser to show.
   *
   * A conversation is all it takes, which is the same condition main offers the browser tools
   * on: the page is keyed on the conversation id and nothing about it is project-shaped. The
   * one thing it cannot do is belong to no conversation, so the toggle stays on screen and
   * disabled on the empty window rather than disappearing from it.
   */
  const browserAvailable = !!activeId;

  // Re-read when a reply ends anywhere, which is the only moment this window knows the balance
  // moved. See useAccountCredits for why it is not polled.
  const credits = useAccountCredits(conversation.settledTurns);

  /**
   * Whether this conversation has a turn open, for the composer's controls.
   *
   * `conversation.streaming` is what THIS window knows of, from the stream or from main's live
   * copy when the conversation was opened, and it can lag main by one round trip either way.
   * The sidebar's status is main's own answer for every session at once, so it covers that gap. 'needs-action' counts: a turn parked
   * at the approval gate is still a turn, and the next message still queues behind it.
   */
  const sessionStatus = activeId ? statuses.get(activeId) : undefined;
  const turnOpen = conversation.streaming || sessionStatus === 'processing' || sessionStatus === 'needs-action';
  const plan = useMemo(() => activeTodos(conversation.messages, turnOpen), [conversation.messages, turnOpen]);

  const workspaceChanges = useWorkspaceChanges(
    screen === 'conversation' ? activeId : null,
    conversation.session?.project,
    conversation.settledTurns
  );
  // The sidebar summary as well as the bar: a dismissed PR bar reports no binding, but the PR is
  // still this session's, and offering to open a second one for the same branch would be wrong.
  const hasPullRequest = !!pullRequest?.binding || (!!activeId && prSummaries.has(activeId));
  const spawned = useMemo(() => spawnedSessions(sessions, statuses, activeId), [sessions, statuses, activeId]);
  const initialCodeSetup = conversation.session?.mode === 'code' && conversation.messages.length === 0;

  /**
   * The session panel: a Code session with a folder after its first message. Until then the same
   * controls are centered in the empty transcript, and a Chat session has nothing to put in it.
   *
   * Docked when it fits beside the reading column, and then its open flag is remembered; on a
   * narrower pane it folds into the header button and opens as a popover, which is never left open
   * across conversations or launches.
   */
  const panelProject =
    !opening && !initialCodeSetup && conversation.session?.mode === 'code' ? conversation.session.project : undefined;
  const panelDocked = threadRegionWidth === null || panelFitsBesideThread(threadRegionWidth);
  const panelShown = !!panelProject && (panelDocked ? panelPrefs.open : panelPopoverOpen);
  const bindingErrorHidden =
    !!panelProject && !!conversation.project.error && (!panelShown || panelPrefs.collapsed.has('environment'));
  const { toggleOpen: togglePanelOpen } = panelPrefs;
  const togglePanel = useCallback(() => {
    if (panelDocked) togglePanelOpen();
    else setPanelPopoverOpen(current => !current);
  }, [panelDocked, togglePanelOpen]);
  const closePanelPopover = useCallback(() => setPanelPopoverOpen(false), []);
  useEffect(() => setPanelPopoverOpen(false), [activeId, panelDocked, screen]);

  const composerUsage: ComposerUsage = useMemo(() => {
    const reply = latestReply(conversation.messages, turnOpen);
    return {
      contextTokens: contextTokens(reply),
      contextLimit: effectiveContextLimit(modelOption?.contextWindow),
      modelWindow: modelOption?.contextWindow ?? null,
      credits: credits.balance,
      monthlyAllowance: credits.monthlyAllowance,
      ...(credits.error ? { creditsError: credits.error } : {}),
      lastTurn: reply?.usage ?? null,
    };
  }, [
    conversation.messages,
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
    : creatingCode
      ? 'Starting a session...'
      : mode === 'code'
        ? 'Start a Code session to type here'
        : 'Start a conversation to type here';

  const onSend = useCallback(
    async (text: string) => {
      const attached = draft.attachments;
      // Cleared before the await so the row does not sit under the composer while the turn is
      // accepted; a rejected turn restores nothing, but its files are still on disk and named
      // in the error.
      draft.clear();
      await conversation.send(text, attached);
    },
    [conversation, draft]
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
    const open = sessions.find(session => session.id === activeId);
    if (open?.mode === mode) return;
    // A live Claude Code CLI session is always the newest import; landing on it would select a
    // row hidden in the shut "Imported from Claude" section instead of the user's own work.
    const candidate = (session: ChatSessionSummary) =>
      session.mode === mode && (importedInline || !isUntouchedImport(session));
    setActiveId(sessions.find(candidate)?.id ?? null);
  }, [settling, activeId, sessions, mode, importedInline]);

  /**
   * Make a session, without touching what the pane is showing. The two callers differ on that:
   * the New button is a click on the sidebar and has to put the transcript back, the first-run
   * seeding below must not pull a user out of the screen they opened.
   *
   * A Code session is created UNBOUND - no directory, no branch - and its empty transcript is where
   * a project gets chosen. Creating one used to open the OS folder picker
   * first, which meant dismissing that dialog produced nothing at all: no session, no message,
   * and no way back in. Nothing is asked up front now, so there is nothing left to cancel.
   */
  const startSession = useCallback(
    async (placement?: SessionPlacement) => {
      if (mode !== 'code') return await create(placement);
      clearCodeError();
      return await createCode({}, placement);
    },
    [mode, create, createCode, clearCodeError]
  );

  /**
   * New, from the sidebar: it makes a session, opens it, and opens nothing else.
   *
   * It deliberately does not follow the open session into its section. What it makes would then
   * depend on which row happens to be selected, which nothing on the button shows, and a user
   * who wanted a loose session would have to move it back out.
   */
  const onCreate = useCallback(async () => {
    setScreen('conversation');
    markSessionStart('new');
    const created = await startSession();
    if (created) setActiveId(created);
  }, [startSession, markSessionStart]);

  /**
   * New, from a user section's header or menu: the same session New makes, but in that section
   * from the moment main mints its id - see CreateSessionRequest.
   */
  const onCreateInSection = useCallback(
    async (sectionId: string) => {
      setScreen('conversation');
      const created = await startSession({
        sectionId,
        placed: adoptSections,
        failed: reportPlacementFailure,
      });
      if (created) setActiveId(created);
    },
    [startSession, adoptSections, reportPlacementFailure]
  );

  /**
   * On first arrival in a mode with nothing in it, make the session instead of sitting on a
   * disabled composer over a sidebar with nothing to pick.
   *
   * This is the whole of a fresh install's first screen: signed in, no sessions, and every
   * control that could get the user moving either disabled or unlabelled. Creating costs
   * nothing here - a Chat session is empty until something is typed, and a Code session is
   * created unbound - so neither one asks a question or touches a folder on the way in.
   *
   * See firstRunSeed.ts for what the ref holds, and why marking the arrival rather than the
   * creation is what keeps this from looping, from seeding on every mode toggle, and from
   * putting a session back the moment the user deletes their last one.
   */
  const arrived = useRef(new Set<ChatSessionMode>());
  useEffect(() => {
    const empty = !sessions.some(session => session.mode === mode);
    if (!seedOnArrival(arrived.current, { loading: settling, mode, hasSessionInMode: !empty })) return;
    void startSession().then(created => {
      if (created) setActiveId(created);
    });
  }, [settling, sessions, mode, startSession]);

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
      const inWorktree =
        worktreeByDefault() && canHoldWorktree(await window.b4m.chat.inspectProject(sibling.directory));
      setScreen('conversation');
      const created = await createCode(newSessionInProject(sibling, inWorktree));
      if (created) setActiveId(created);
    },
    [sessions, createCode, clearCodeError, markSessionStart]
  );

  const onDelete = useCallback(
    async (sessionId: string) => {
      await remove(sessionId);
      setActiveId(current => (current === sessionId ? null : current));
    },
    [remove]
  );

  return (
    <Box sx={chatShellRootSx} {...drop.handlers} data-testid="chat-shell">
      <SpawnFailureToast />
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

      <SessionList
        sessions={sessions}
        mode={mode}
        onModeChange={setMode}
        loading={loading}
        activeId={activeId}
        statuses={statuses}
        prSummaries={prSummaries}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(current => !current)}
        onSelect={selectSession}
        onCreate={() => void onCreate()}
        onOpenArtifacts={() => setScreen('artifacts')}
        onCreateInProject={directory => void onCreateInProject(directory)}
        onCreateInSection={sectionId => void onCreateInSection(sectionId)}
        onDelete={sessionId => void onDelete(sessionId)}
        onTogglePin={session => void togglePin(session)}
        onToggleArchived={session => void toggleArchived(session)}
        onRename={(session, title) => void rename(session, title)}
        renameError={renameError}
        onDismissRenameError={clearRenameError}
        userSections={userSections}
        sectionActions={sectionActions}
        sectionError={sectionError}
        onDismissSectionError={dismissSectionError}
        customize={<CustomizeNavItem onOpen={() => setScreen('customize')} />}
        footer={account?.(
          <TurnDot state={turnState({ streaming: turnOpen, disabled: !activeId || creatingCode, notReady: unbound })} />
        )}
      />

      {screen === 'artifacts' ? (
        <ArtifactLibraryPanel onClose={() => setScreen('conversation')} />
      ) : screen === 'skill-market' ? (
        <SkillMarketPanel initial={marketListing} onClose={() => setScreen('customize')} />
      ) : screen === 'customize' ? (
        <CustomizeScreen
          sessionId={activeId}
          onClose={() => setScreen('conversation')}
          onOpenSkillMarket={openSkillMarket}
        />
      ) : (
        <Stack ref={conversationColumn} sx={{ flex: 1, minWidth: 0, ...columnStackSx }}>
          <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ ...contentColumnSx, py: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {conversation.session ? (
                  <>
                    <SessionHeader
                      title={activeSummary?.title ?? conversation.session.title}
                      onRename={title =>
                        void (activeSummary ? rename(activeSummary, title) : conversation.rename(title))
                      }
                    />
                    {conversation.session.project && <WorkingDirectoryLine project={conversation.session.project} />}
                  </>
                ) : opening ? null : (
                  <Typography level="title-sm" textColor="text.tertiary">
                    No conversation open
                  </Typography>
                )}
              </Box>
              {panelProject && (
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
              {!opening && conversation.session && (
                <Tooltip title="Keep this conversation and its visited pages in the local search index.">
                  <Switch
                    size="sm"
                    checked={conversation.session.historyEnabled === true}
                    onChange={event => void conversation.setHistory(event.target.checked)}
                    slotProps={{ input: { 'aria-label': 'Local history', 'data-testid': 'chat-history-switch' } }}
                  />
                </Tooltip>
              )}
              {/* Inside the reading column, not out at the window edge: a tooltip opening from
                  here cannot reach the pane, and a tooltip over the pane would be drawn behind
                  the web page - see agentBrowser.ts. */}
              <Tooltip
                size="sm"
                variant="soft"
                placement="bottom-end"
                title={
                  activeId
                    ? terminalOpen
                      ? 'Hide the terminal (Ctrl+`)'
                      : 'Show the terminal (Ctrl+`)'
                    : 'Open a conversation to use the terminal.'
                }
              >
                <Box component="span" sx={{ display: 'inline-flex' }}>
                  <IconButton
                    size="sm"
                    variant={terminalOpen ? 'soft' : 'plain'}
                    color="neutral"
                    disabled={!activeId}
                    aria-pressed={terminalOpen}
                    aria-label={terminalOpen ? 'Hide the terminal' : 'Show the terminal'}
                    onClick={toggleTerminal}
                    data-testid="chat-toggle-terminal-btn"
                  >
                    <TerminalIcon />
                  </IconButton>
                </Box>
              </Tooltip>
              <Tooltip
                size="sm"
                variant="soft"
                placement="bottom-end"
                title={
                  browserAvailable
                    ? browserOpen
                      ? 'Hide the browser'
                      : 'Show the browser'
                    : 'Open a conversation to use the browser.'
                }
              >
                <Box component="span" sx={{ display: 'inline-flex' }}>
                  <IconButton
                    size="sm"
                    variant={browserOpen && browserAvailable ? 'soft' : 'plain'}
                    color="neutral"
                    disabled={!browserAvailable}
                    aria-pressed={browserOpen && browserAvailable}
                    aria-label={browserOpen ? 'Hide the browser' : 'Show the browser'}
                    onClick={toggleBrowser}
                    data-testid="chat-toggle-browser-btn"
                  >
                    <GlobeIcon />
                  </IconButton>
                </Box>
              </Tooltip>
            </Box>
          </Box>

          {/* The region the session panel floats over: the thread and nothing below it, so the
              card can never reach the composer, and everything it does not cover stays live. */}
          <Box
            ref={threadRegion}
            sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            {opening ? (
              <Box sx={{ flex: 1 }} data-testid="chat-thread-opening" />
            ) : (
              <VideoJobsContext.Provider value={videoJobs}>
                <WebLinkContext.Provider value={openInBrowserPane}>
                  {/* Keyed so an open menu can never carry an image into another conversation,
                    should a switch ever skip the `opening` gate that unmounts this today. */}
                  <ImageMenuProvider key={activeId ?? 'none'} onAttach={activeId ? draft.attachImage : undefined}>
                    <MessageThread
                      // Remounted per conversation, so its window and scroll start over and nothing it
                      // set going outlives the conversation it was for. Prefixed, as the session panel
                      // beside it is: two siblings sharing a key leave one of them mounted in the DOM
                      // after React drops it.
                      key={`thread-${activeId ?? 'none'}`}
                      messages={conversation.messages}
                      sessionId={activeId}
                      // What stands in for the transcript when there is no session to have one. It is the
                      // only control on screen that starts one from here, so it is a button and not a
                      // sentence pointing at the sidebar: the header above says what the state is, this
                      // says what to do about it, and the composer's placeholder names the same step.
                      noSession={
                        <Stack spacing={1.5} alignItems="center">
                          <Typography level="body-sm" textColor="text.tertiary" data-testid="chat-thread-no-session">
                            {mode === 'code'
                              ? 'Start a Code session to run a task here.'
                              : 'Start a conversation to send your first message.'}
                          </Typography>
                          <Button
                            size="sm"
                            variant="soft"
                            loading={creatingCode}
                            onClick={() => void onCreate()}
                            data-testid="chat-start-session-btn"
                          >
                            {mode === 'code' ? 'New Code session' : 'New conversation'}
                          </Button>
                        </Stack>
                      }
                      emptySession={
                        initialCodeSetup ? (
                          <Box
                            sx={{ width: '100%', maxWidth: 420, minWidth: 0 }}
                            data-testid="chat-code-workspace-setup"
                          >
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
                        ) : undefined
                      }
                      // turnOpen, not `streaming`: a turn this window never saw start - after a reload, or
                      // one parked at the approval gate - is still running, and Continue must not be
                      // offered on top of it.
                      streaming={turnOpen}
                      onRespond={conversation.respondToApproval}
                      onMove={background.moveToBackground}
                      onContinue={() => void conversation.continueReply()}
                      status={conversation.turn && <TurnStatus turn={conversation.turn} activity={activity} />}
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
                  </ImageMenuProvider>
                </WebLinkContext.Provider>
              </VideoJobsContext.Provider>
            )}

            {panelShown && panelProject && conversation.session && (
              <SessionPanel
                // Keyed so an action error or an unfolded list does not follow the user to the next
                // conversation.
                key={`panel-${activeId ?? 'none'}`}
                variant={panelDocked ? 'docked' : 'popover'}
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
                  processes: background.processes,
                  spawned,
                  onStopProcess: background.stop,
                  onStopSession: sessionId => void window.b4m.chat.stopReply(sessionId),
                  onOpenSession: selectSession,
                  onShowOutput: () => setTasksPanelOpen(true),
                }}
              />
            )}
          </Box>

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
                sx={{ cursor: 'pointer' }}
                onClick={conversation.dismissNotice}
                data-testid="chat-notice"
              >
                {conversation.notice}
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

          <SpawnSuggestionTray
            suggestions={spawnSuggestions.suggestions}
            onStart={onStartSuggestion}
            onDismiss={spawnSuggestions.dismiss}
          />

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

          <Composer
            sessionId={activeId}
            disabled={!activeId || creatingCode}
            disabledPlaceholder={disabledPlaceholder}
            streaming={turnOpen}
            attachments={draft}
            blockedReason={blockedReason}
            // Blocked rather than refused: a refused send has already cleared the box.
            notReady={
              auth?.reauthRequired && !(conversation.session && isLocalModel(conversation.session.model))
                ? 'Sign in'
                : unbound
                  ? 'No folder'
                  : null
            }
            usage={composerUsage}
            placeholder={
              conversation.session?.mode === 'code' ? 'Describe a task or ask a question' : 'Send a message...'
            }
            onSend={text => void onSend(text)}
            onStop={conversation.stop}
            onRunCommand={(name, args) => void conversation.runCommand(name, args)}
            onBrowseSkillMarket={() => openSkillMarket()}
            sessionMode={conversation.session?.mode ?? 'chat'}
            suggestion={nextPrompt.suggestion}
            onSuggestionDismissed={nextPrompt.dismiss}
            queued={conversation.queued}
            onCancelQueued={conversation.cancelQueued}
            onSendQueuedNow={conversation.sendQueuedNow}
            returned={conversation.returned}
            onReturnedConsumed={conversation.clearReturned}
            skills={skills}
            leading={
              <ApprovalModePill
                mode={conversation.session?.approvalMode ?? 'ask'}
                disabled={!activeId}
                onSelect={mode => void conversation.setApprovalMode(mode)}
              />
            }
            footer={
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                <ModelPicker
                  catalog={catalog}
                  modelId={conversation.session?.model ?? null}
                  disabled={!activeId}
                  onSelect={model => void conversation.setModel(model)}
                />
                <ReasoningEffortPicker
                  models={catalog.models}
                  modelId={conversation.session?.model ?? null}
                  effort={conversation.session?.reasoningEffort ?? 'default'}
                  disabled={!activeId}
                  onSelect={effort => void conversation.setReasoningEffort(effort)}
                />
              </Stack>
            }
          />

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
      )}

      {/* The third column: a sibling of the conversation in the shell's flex row, not an
        overlay. The conversation keeps `flex: 1, minWidth: 0` and its reading column keeps
        `mx: 'auto'`, so opening this re-centres the transcript and the composer together -
        they share contentColumnSx, and neither one is told the panel exists.

        It is mounted only when there is something to show, so a panel left open never eats
        width on a conversation that has no background commands. */}
      {tasksOpen && background.processes.length > 0 && (
        <BackgroundTaskPanel
          processes={background.processes}
          wide={tasksWide}
          onToggleWide={toggleTasksWide}
          onClose={() => setTasksPanelOpen(false)}
          onStop={background.stop}
          onClearFinished={background.clearFinished}
        />
      )}

      {/* Last in the row, so the web page is at the window's own right edge.

        Unlike every other column here, what this one reserves is a hole for a NATIVE view the
        main process draws in front of the renderer. It is therefore mounted only on the
        conversation screen - the artifacts and customize screens take the whole pane and a web
        page floating over them would be unreachable - and it is told to stand down while the
        drop overlay is up, which is drawn in the React tree and so would be behind it. */}
      {browserOpen && browserAvailable && screen === 'conversation' && (
        <BrowserPane sessionId={activeId} suspended={drop.over} conversation={conversationColumn} />
      )}
    </Box>
  );
}

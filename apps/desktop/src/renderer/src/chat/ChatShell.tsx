import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import type { ChatProject, ChatSessionMode } from '@shared/chat';
import { effectiveContextLimit } from '@shared/contextLimit';
import { activeTodos } from '@shared/todos';
import { ArtifactLibraryPanel } from './ArtifactLibraryPanel';
import { BackgroundTaskChip, BackgroundTaskPanel } from './BackgroundTaskPanel';
import { readPanelFlag, writePanelFlag } from './backgroundTasks';
import { BrowserPane } from './BrowserPane';
import { readBrowserPaneOpen, writeBrowserPaneOpen } from './agentBrowser';
import { ApprovalModePill } from './ApprovalModePill';
import { Composer } from './Composer';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';
import { GlobeIcon } from './icons';
import { MessageThread } from './MessageThread';
import { columnStackSx, contentColumnSx } from './layout';
import { ModelPicker } from './ModelPicker';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { SessionChips } from './SessionChips';
import { PrStatusBar } from './PrStatusBar';
import { usePullRequest } from './usePullRequest';
import { SessionList } from './SessionList';
import { SettingsScreen } from './SettingsPanel';
import { TodoPanel } from './TodoPanel';
import { TurnDot, turnState } from './TurnDot';
import { TurnStatus } from './TurnStatus';
import { presentReply } from './codeStream';
import { seedOnArrival } from './firstRunSeed';
import { newSessionInProject } from './newSessionInProject';
import { roundsOf } from './replyRounds';
import { contextTokens, describeActivity, latestReply, type ComposerUsage } from './statusLine';
import { useAccountCredits } from './useAccountCredits';
import { toAttachmentInputs, useAttachmentDraft } from './useAttachments';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { useConversation, useModelCatalog, useSessionStatuses, useSessions } from './useChat';
import { usePromptSuggestion } from './usePromptSuggestion';
import { useFileDrop } from './useFileDrop';
import { useSkills } from './useSkills';

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
        slotProps={{ input: { 'data-testid': 'chat-rename-input' } }}
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
 * worktree toggle: the chip row above the composer says which branch and that a worktree is on,
 * and this is the one thing it cannot fit - where that resolved to.
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
type ChatScreen = 'conversation' | 'artifacts' | 'customize' | 'settings';

/**
 * The sidebar's account strip, given the dot that says whether a reply is running and the way
 * to open Settings.
 *
 * A function rather than a node because the two halves are owned in different places: this
 * component knows the turn state, and the account strip knows where a glyph goes in its own
 * row. Handing the finished dot down keeps both where they belong - see TurnDot. The opener
 * rides along for the same reason: Settings is a screen in this pane, and the account menu is
 * where a user who knew the server lived under their name will still go looking for it.
 */
export type AccountStrip = (status: ReactNode, openSettings: () => void) => ReactNode;

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
    apply,
  } = useSessions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatSessionMode>('chat');
  const conversation = useConversation(activeId, apply);
  const background = useBackgroundProcesses(activeId);
  const skills = useSkills(activeId);
  const catalog = useModelCatalog();
  const statuses = useSessionStatuses();
  const [collapsed, setCollapsed] = useState(false);
  const [screen, setScreen] = useState<ChatScreen>('conversation');
  // Window chrome, so it is remembered per machine rather than per conversation. Seeded from
  // storage on the first render and written back on every change, which is the whole of the
  // persistence - see backgroundTasks.ts for the keys and the blocked-storage fallback.
  const [tasksOpen, setTasksOpen] = useState(() => readPanelFlag('open'));
  const [tasksWide, setTasksWide] = useState(() => readPanelFlag('wide'));
  const [browserOpen, setBrowserOpen] = useState(() => readBrowserPaneOpen());
  const draft = useAttachmentDraft(activeId);
  const nextPrompt = usePromptSuggestion(activeId);
  // Only the conversation screen counts as showing one: main polls what is on screen faster.
  const pullRequest = usePullRequest(screen === 'conversation' ? activeId : null);

  // Stable, because the account strip is rebuilt on every turn of the conversation and this is
  // the one thing in it that has no reason to change.
  const openSettings = useCallback(() => setScreen('settings'), []);

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

  // A Code session with no project has no working directory, so main refuses the turn. Nothing
  // is written out in prose: the unset folder chip a few pixels above is the thing to act on,
  // and the composer names the state in one word where the reader already looks for "can I
  // send?". Main's refusal stays as the guard, and surfaces through chat-send-error if a turn
  // ever reaches it.
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

  /**
   * What the composer's usage indicator reports: how full the window is, and what is left.
   *
   * The context figure comes from the last reply's LAST request, never from the turn's summed
   * usage - see contextTokens. It is measured against the capped limit (effectiveContextLimit)
   * rather than the raw window, and that limit is real even for a model that states no window:
   * the cap applies either way.
   *
   * `turnOpen` is handed on so the figure survives the turn it is shown during: the reply being
   * streamed has measured nothing yet, and without it the indicator would read as unknown from
   * the moment the user pressed send until the reply landed. See latestReply.
   */
  const composerUsage: ComposerUsage = useMemo(() => {
    const reply = latestReply(conversation.messages, turnOpen);
    return {
      contextTokens: contextTokens(reply),
      contextLimit: effectiveContextLimit(modelOption?.contextWindow),
      modelWindow: modelOption?.contextWindow ?? null,
      credits: credits.balance,
      ...(credits.error ? { creditsError: credits.error } : {}),
      lastTurn: reply?.usage ?? null,
    };
  }, [conversation.messages, turnOpen, modelOption?.contextWindow, credits.balance, credits.error]);

  // What the turn in flight is doing, read off the reply being streamed into the thread. Only
  // the last message can be that reply, so nothing earlier is consulted.
  const inFlight = conversation.messages[conversation.messages.length - 1];
  const liveText = inFlight ? (roundsOf(inFlight).at(-1)?.text ?? '') : '';
  const activity = describeActivity(
    inFlight?.toolCalls ?? [],
    (inFlight?.content.length ?? 0) > 0,
    presentReply(liveText, true).pending
  );

  /**
   * What the composer says while it will not take a keystroke. It has to name the step that is
   * actually open: there is no conversation to "pick" on a fresh install, so the old copy sent
   * the user looking for a list that says "No Code sessions yet." The button in the empty pane
   * is the step, and this points at it.
   */
  const disabledPlaceholder = creatingCode
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
    if (loading) return;
    const open = sessions.find(session => session.id === activeId);
    if (open?.mode === mode) return;
    setActiveId(sessions.find(session => session.mode === mode)?.id ?? null);
  }, [loading, activeId, sessions, mode]);

  /**
   * Make a session, without touching what the pane is showing. The two callers differ on that:
   * the New button is a click on the sidebar and has to put the transcript back, the first-run
   * seeding below must not pull a user out of the screen they opened.
   *
   * A Code session is created UNBOUND - no directory, no branch - and the chip row above the
   * composer is where a project gets chosen. Creating one used to open the OS folder picker
   * first, which meant dismissing that dialog produced nothing at all: no session, no message,
   * and no way back in. Nothing is asked up front now, so there is nothing left to cancel.
   */
  const startSession = useCallback(async () => {
    if (mode !== 'code') return await create();
    clearCodeError();
    return await createCode({});
  }, [mode, create, createCode, clearCodeError]);

  /** New, from the sidebar: it makes a session, opens it, and opens nothing else. */
  const onCreate = useCallback(async () => {
    setScreen('conversation');
    const created = await startSession();
    if (created) setActiveId(created);
  }, [startSession]);

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
    if (!seedOnArrival(arrived.current, { loading, mode, hasSessionInMode: !empty })) return;
    void startSession().then(created => {
      if (created) setActiveId(created);
    });
  }, [loading, sessions, mode, startSession]);

  /**
   * Another session in the same project, from the group header's "+".
   *
   * The folder is what defines the group, so it carries across and the dialog stays shut.
   * Nothing else does - see newSessionInProject for why the branch is left for the user to
   * pick on the new session.
   */
  const onCreateInProject = useCallback(
    async (directory: string) => {
      const sibling = sessions.find(session => session.project?.directory === directory)?.project;
      if (!sibling) return;
      setScreen('conversation');
      clearCodeError();
      const created = await createCode(newSessionInProject(sibling));
      if (created) setActiveId(created);
    },
    [sessions, createCode, clearCodeError]
  );

  const onDelete = useCallback(
    async (sessionId: string) => {
      await remove(sessionId);
      setActiveId(current => (current === sessionId ? null : current));
    },
    [remove]
  );

  return (
    <Box sx={{ position: 'relative', display: 'flex', height: '100vh', bgcolor: 'background.body' }} {...drop.handlers}>
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
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(current => !current)}
        onSelect={sessionId => {
          // A screen takes over the same pane the transcript lives in, so picking a
          // conversation has to put it back or the click reads as doing nothing.
          setScreen('conversation');
          setActiveId(sessionId);
        }}
        onCreate={() => void onCreate()}
        onOpenArtifacts={() => setScreen('artifacts')}
        onCreateInProject={directory => void onCreateInProject(directory)}
        onDelete={sessionId => void onDelete(sessionId)}
        onTogglePin={session => void togglePin(session)}
        onToggleArchived={session => void toggleArchived(session)}
        customize={<CustomizeNavItem onOpen={() => setScreen('customize')} />}
        footer={account?.(
          <TurnDot
            state={turnState({ streaming: turnOpen, disabled: !activeId || creatingCode, notReady: unbound })}
          />,
          openSettings
        )}
      />

      {screen === 'artifacts' ? (
        <ArtifactLibraryPanel onClose={() => setScreen('conversation')} />
      ) : screen === 'customize' ? (
        <CustomizeScreen onClose={() => setScreen('conversation')} />
      ) : screen === 'settings' ? (
        <SettingsScreen auth={auth ?? null} onClose={() => setScreen('conversation')} />
      ) : (
        <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }}>
          <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ ...contentColumnSx, py: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {conversation.session ? (
                  <>
                    <SessionHeader
                      title={conversation.session.title}
                      onRename={title => void conversation.rename(title)}
                    />
                    {conversation.session.project && <WorkingDirectoryLine project={conversation.session.project} />}
                  </>
                ) : (
                  <Typography level="title-sm" textColor="text.tertiary">
                    No conversation open
                  </Typography>
                )}
              </Box>
              {/* Inside the reading column, not out at the window edge: a tooltip opening from
                  here cannot reach the pane, and a tooltip over the pane would be drawn behind
                  the web page - see agentBrowser.ts. */}
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

          <MessageThread
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
            footer={<BackgroundTaskChip running={background.running} onClick={() => setTasksPanelOpen(true)} />}
          />

          <TodoPanel todos={plan} turnOpen={turnOpen} />

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

          {/* Every Code session, bound or not. The chips are how a project is chosen, so gating
            them on one already being chosen is what made them unreachable. */}
          {conversation.session?.mode === 'code' && (
            <SessionChips
              project={conversation.session.project ?? null}
              binding={conversation.project}
              settledTurns={conversation.settledTurns}
              inUse={conversation.messages.length > 0}
            />
          )}

          <PrStatusBar
            // Keyed so an action error on one conversation's bar does not follow the user to the next.
            key={activeId ?? 'none'}
            state={pullRequest}
            onDismiss={() =>
              activeId ? window.b4m.pullRequests.dismiss(activeId) : Promise.resolve({ ok: true as const })
            }
            onRefresh={() => activeId && void window.b4m.pullRequests.refresh(activeId)}
            onSetOption={(option, enabled) =>
              activeId
                ? window.b4m.pullRequests.setOption(activeId, option, enabled)
                : Promise.resolve({ ok: false as const, error: 'No conversation is open.' })
            }
          />

          <Composer
            sessionId={activeId}
            disabled={!activeId || creatingCode}
            disabledPlaceholder={disabledPlaceholder}
            streaming={turnOpen}
            attachments={draft}
            blockedReason={blockedReason}
            notReady={unbound ? 'No folder' : null}
            usage={composerUsage}
            placeholder={
              conversation.session?.mode === 'code' ? 'Describe a task or ask a question' : 'Send a message...'
            }
            onSend={text => void onSend(text)}
            onStop={conversation.stop}
            onRunCommand={(name, args) => void conversation.runCommand(name, args)}
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
        <BrowserPane sessionId={activeId} suspended={drop.over} />
      )}
    </Box>
  );
}

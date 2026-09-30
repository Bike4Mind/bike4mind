import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatProject, ChatSessionMode } from '@shared/chat';
import { ArtifactLibraryPanel } from './ArtifactLibraryPanel';
import { BackgroundTaskChip, BackgroundTaskPanel } from './BackgroundTaskPanel';
import { readPanelFlag, writePanelFlag } from './backgroundTasks';
import { ApprovalModePill } from './ApprovalModePill';
import { Composer } from './Composer';
import { CustomizeNavItem, CustomizeScreen } from './CustomizePanel';
import { MessageThread } from './MessageThread';
import { columnStackSx, contentColumnSx } from './layout';
import { ModelPicker } from './ModelPicker';
import { SessionChips } from './SessionChips';
import { SessionList } from './SessionList';
import { TurnStatus } from './TurnStatus';
import { presentReply } from './codeStream';
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
type ChatScreen = 'conversation' | 'artifacts' | 'customize';

export function ChatShell({ account }: { account?: ReactNode }) {
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
  const draft = useAttachmentDraft(activeId);
  const nextPrompt = usePromptSuggestion(activeId);

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

  // Re-read when a reply ends anywhere, which is the only moment this window knows the balance
  // moved. See useAccountCredits for why it is not polled.
  const credits = useAccountCredits(conversation.settledTurns);

  /**
   * What the composer's idle indicator reports: how full the window is, and what is left.
   *
   * The context figure comes from the last reply's LAST request, never from the turn's summed
   * usage - see contextTokens. `contextWindow` falls back to null rather than to a default,
   * because a percentage of a made-up window is a number the user cannot tell is wrong.
   */
  const composerUsage: ComposerUsage = useMemo(() => {
    const reply = latestReply(conversation.messages);
    return {
      contextTokens: contextTokens(reply),
      contextWindow: modelOption?.contextWindow ?? null,
      credits: credits.balance,
      ...(credits.error ? { creditsError: credits.error } : {}),
      lastTurn: reply?.usage ?? null,
    };
  }, [conversation.messages, modelOption?.contextWindow, credits.balance, credits.error]);

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

  // What the turn in flight is doing, read off the reply being streamed into the thread. Only
  // the last message can be that reply, so nothing earlier is consulted.
  const inFlight = conversation.messages[conversation.messages.length - 1];
  const liveText = inFlight ? (roundsOf(inFlight).at(-1)?.text ?? '') : '';
  const activity = describeActivity(
    inFlight?.toolCalls ?? [],
    (inFlight?.content.length ?? 0) > 0,
    presentReply(liveText, true).pending
  );

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
   * Start a session. New behaves the same in both modes: it makes one, and opens nothing.
   *
   * A Code session is created UNBOUND - no directory, no branch - and the chip row above the
   * composer is where a project gets chosen. Creating one used to open the OS folder picker
   * first, which meant dismissing that dialog produced nothing at all: no session, no message,
   * and no way back in. Nothing is asked up front now, so there is nothing left to cancel.
   */
  const onCreate = useCallback(async () => {
    setScreen('conversation');
    if (mode !== 'code') {
      setActiveId(await create());
      return;
    }
    clearCodeError();
    const created = await createCode({});
    if (created) setActiveId(created);
  }, [mode, create, createCode, clearCodeError]);

  /**
   * Another session in the same project, from the group header's "+".
   *
   * It reuses the existing binding rather than reopening the dialog: the project, branch and
   * workspace choice are what define the group, so asking for them again to land in the same
   * group would be a form to fill in with the only answer that works.
   */
  const onCreateInProject = useCallback(
    async (directory: string) => {
      const sibling = sessions.find(session => session.project?.directory === directory)?.project;
      if (!sibling) return;
      setScreen('conversation');
      const created = await createCode({
        directory: sibling.directory,
        branch: sibling.branch,
        workspace: sibling.workspace,
        contextDirectories: sibling.contextDirectories,
      });
      if (created) setActiveId(created);
    },
    [sessions, createCode]
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
        footer={account}
      />

      {screen === 'artifacts' ? (
        <ArtifactLibraryPanel onClose={() => setScreen('conversation')} />
      ) : screen === 'customize' ? (
        <CustomizeScreen onClose={() => setScreen('conversation')} />
      ) : (
        <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }}>
          <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ ...contentColumnSx, py: 1.25 }}>
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
          </Box>

          <MessageThread
            messages={conversation.messages}
            sessionId={activeId}
            // turnOpen, not `streaming`: a turn this window never saw start - after a reload, or
            // one parked at the approval gate - is still running, and Continue must not be
            // offered on top of it.
            streaming={turnOpen}
            onRespond={conversation.respondToApproval}
            onContinue={() => void conversation.continueReply()}
            status={conversation.turn && <TurnStatus turn={conversation.turn} activity={activity} />}
            // At the foot of the thread rather than above the composer: a background command is
            // something this conversation started, so it reads as the last thing that happened
            // in it. It scrolls with the transcript, which is the trade - the panel is reached
            // from the bottom of the thread, not from a bar that is always on screen.
            footer={<BackgroundTaskChip running={background.running} onClick={() => setTasksPanelOpen(true)} />}
          />

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
            <SessionChips project={conversation.session.project ?? null} binding={conversation.project} />
          )}

          <Composer
            sessionId={activeId}
            disabled={!activeId || creatingCode}
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
            suggestion={nextPrompt.suggestion}
            onSuggestionDismissed={nextPrompt.dismiss}
            queued={conversation.queued}
            onCancelQueued={conversation.cancelQueued}
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
              <ModelPicker
                catalog={catalog}
                modelId={conversation.session?.model ?? null}
                disabled={!activeId}
                onSelect={model => void conversation.setModel(model)}
              />
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
    </Box>
  );
}

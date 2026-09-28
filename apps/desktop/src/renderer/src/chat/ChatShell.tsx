import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatProject, ChatSessionMode, CreateCodeSessionRequest } from '@shared/chat';
import { BackgroundProcessPanel } from './BackgroundProcessPanel';
import { Composer } from './Composer';
import { FolderAccess } from './FolderAccess';
import { MessageThread } from './MessageThread';
import { contentColumnSx } from './layout';
import { ModelPicker } from './ModelPicker';
import { NewCodeSessionDialog } from './NewCodeSessionDialog';
import { SessionList } from './SessionList';
import { SidebarCard } from './SidebarCard';
import { SidebarShortcuts } from './SidebarShortcuts';
import { TurnStatus } from './TurnStatus';
import { describeActivity } from './statusLine';
import { toAttachmentInputs, useAttachmentDraft } from './useAttachments';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { useConversation, useModelCatalog, useSessionStatuses, useSessions } from './useChat';
import { useFileDrop } from './useFileDrop';

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
 * Where a Code session is grounded, under its title. The working directory is shown whenever it
 * differs from the project, because that difference IS the workspace toggle: a user who cannot
 * see it has no way to tell which checkout their commands just ran in.
 */
function ProjectBar({ project }: { project: ChatProject }) {
  const relocated = project.workingDirectory !== project.directory;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }} data-testid="chat-project-bar">
      <Chip size="sm" variant="soft" color="primary">
        {project.name}
      </Chip>
      {project.branch && (
        <Chip size="sm" variant="soft" color="neutral" data-testid="chat-project-branch">
          {project.branch}
        </Chip>
      )}
      <Tooltip title={project.workingDirectory} size="sm" variant="soft" placement="bottom-start">
        <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="chat-project-cwd">
          {relocated ? `worktree: ${project.workingDirectory}` : project.directory}
        </Typography>
      </Tooltip>
    </Stack>
  );
}

export function ChatShell({ account }: { account?: ReactNode }) {
  const { sessions, loading, create, createCode, creatingCode, codeError, clearCodeError, remove, togglePin, apply } =
    useSessions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatSessionMode>('chat');
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const conversation = useConversation(activeId, apply);
  const background = useBackgroundProcesses(activeId);
  const catalog = useModelCatalog();
  const statuses = useSessionStatuses();
  const [collapsed, setCollapsed] = useState(false);
  const draft = useAttachmentDraft(activeId);

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

  // What the turn in flight is doing, read off the reply being streamed into the thread. Only
  // the last message can be that reply, so nothing earlier is consulted.
  const inFlight = conversation.messages[conversation.messages.length - 1];
  const activity = describeActivity(inFlight?.toolCalls ?? [], (inFlight?.content.length ?? 0) > 0);

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

  const onCreate = useCallback(async () => {
    if (mode === 'code') {
      clearCodeError();
      setCodeDialogOpen(true);
      return;
    }
    setActiveId(await create());
  }, [mode, create, clearCodeError]);

  const onCreateCode = useCallback(
    async (request: CreateCodeSessionRequest) => {
      const created = await createCode(request);
      if (!created) return;
      setCodeDialogOpen(false);
      setActiveId(created);
    },
    [createCode]
  );

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
        onSelect={setActiveId}
        onCreate={() => void onCreate()}
        onCreateInProject={directory => void onCreateInProject(directory)}
        onDelete={sessionId => void onDelete(sessionId)}
        onTogglePin={session => void togglePin(session)}
        customize={<FolderAccess />}
        more={<SidebarShortcuts />}
        card={<SidebarCard />}
        footer={account}
      />

      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ ...contentColumnSx, py: 1.25 }}>
            {conversation.session ? (
              <>
                <SessionHeader title={conversation.session.title} onRename={title => void conversation.rename(title)} />
                {conversation.session.project && <ProjectBar project={conversation.session.project} />}
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
          onRespond={conversation.respondToApproval}
        />

        <TurnStatus turn={conversation.turn} activity={activity} />

        {conversation.sendError && (
          <Alert size="sm" color="danger" variant="soft" sx={contentColumnSx} data-testid="chat-send-error">
            {conversation.sendError}
          </Alert>
        )}

        {conversation.notice && (
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            sx={{ ...contentColumnSx, cursor: 'pointer' }}
            onClick={conversation.dismissNotice}
            data-testid="chat-notice"
          >
            {conversation.notice}
          </Alert>
        )}

        <BackgroundProcessPanel processes={background.processes} onStop={background.stop} />

        <Composer
          sessionId={activeId}
          disabled={!activeId}
          streaming={conversation.streaming}
          attachments={draft}
          blockedReason={blockedReason}
          onSend={text => void onSend(text)}
          onStop={conversation.stop}
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

      <NewCodeSessionDialog
        open={codeDialogOpen}
        onClose={() => setCodeDialogOpen(false)}
        onCreate={request => void onCreateCode(request)}
        error={codeError}
        busy={creatingCode}
      />
    </Box>
  );
}

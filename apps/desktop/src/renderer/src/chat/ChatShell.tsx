import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { BackgroundProcessPanel } from './BackgroundProcessPanel';
import { Composer } from './Composer';
import { MessageThread } from './MessageThread';
import { contentColumnSx } from './layout';
import { ModelPicker } from './ModelPicker';
import { SessionList } from './SessionList';
import { toAttachmentInputs, useAttachmentDraft } from './useAttachments';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { useConversation, useModelCatalog, useSessions } from './useChat';
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

export function ChatShell({ account }: { account?: ReactNode }) {
  const { sessions, loading, create, remove, apply } = useSessions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const conversation = useConversation(activeId, apply);
  const background = useBackgroundProcesses(activeId);
  const catalog = useModelCatalog();
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

  // Open the most recent conversation on first load so the app lands somewhere useful rather
  // than on an empty pane. Only until the user picks one - after that, their choice stands.
  useEffect(() => {
    if (!loading && !activeId && sessions.length > 0) setActiveId(sessions[0].id);
  }, [loading, activeId, sessions]);

  const onCreate = useCallback(async () => {
    setActiveId(await create());
  }, [create]);

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
        loading={loading}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => void onCreate()}
        onDelete={sessionId => void onDelete(sessionId)}
        footer={account}
      />

      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ ...contentColumnSx, py: 1.25 }}>
            {conversation.session ? (
              <SessionHeader title={conversation.session.title} onRename={title => void conversation.rename(title)} />
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
          streaming={conversation.streaming}
          onRespond={conversation.respondToApproval}
        />

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
    </Box>
  );
}

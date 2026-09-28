import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { Composer } from './Composer';
import { MessageThread } from './MessageThread';
import { contentColumnSx } from './layout';
import { SessionList } from './SessionList';
import { useConversation, useSessions } from './useChat';

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
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: 'background.body' }}>
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

        <MessageThread messages={conversation.messages} streaming={conversation.streaming} />

        {conversation.sendError && (
          <Alert size="sm" color="danger" variant="soft" sx={contentColumnSx} data-testid="chat-send-error">
            {conversation.sendError}
          </Alert>
        )}

        <Composer
          disabled={!activeId}
          streaming={conversation.streaming}
          onSend={text => void conversation.send(text)}
          onStop={conversation.stop}
        />
      </Stack>
    </Box>
  );
}

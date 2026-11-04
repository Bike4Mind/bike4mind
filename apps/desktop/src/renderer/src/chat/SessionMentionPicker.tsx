import { useEffect, useRef } from 'react';
import Box from '@mui/joy/Box';
import List from '@mui/joy/List';
import ListItemButton from '@mui/joy/ListItemButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { contentColumnSx } from './layout';
import { NO_PROJECT_LABEL, type MentionableSession } from './sessionMentionMenu';

const MAX_HEIGHT = 280;

/**
 * The `@` menu above the composer. A plain listbox the composer drives, for the reason
 * SkillPicker is: the textarea keeps focus so typing keeps filtering.
 */
export function SessionMentionPicker({
  sessions,
  activeIndex,
  onPick,
}: {
  sessions: readonly MentionableSession[];
  activeIndex: number;
  onPick: (session: MentionableSession) => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }}>
      <Sheet
        variant="outlined"
        sx={{ borderRadius: 'md', maxHeight: MAX_HEIGHT, overflowY: 'auto' }}
        data-testid="composer-mention-menu"
      >
        <List size="sm" sx={{ '--ListItem-paddingY': '6px' }}>
          {sessions.map((session, index) => (
            <ListItemButton
              key={session.id}
              ref={index === activeIndex ? activeRef : undefined}
              selected={index === activeIndex}
              onMouseDown={event => {
                event.preventDefault();
                onPick(session);
              }}
              data-testid="composer-mention-option"
              data-session-id={session.id}
            >
              <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0, width: '100%' }}>
                <Typography level="title-sm" noWrap sx={{ minWidth: 0, flex: 1 }}>
                  {session.title}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flexShrink: 0, maxWidth: '40%' }}>
                  {session.projectName ?? NO_PROJECT_LABEL}
                </Typography>
              </Stack>
            </ListItemButton>
          ))}
        </List>
      </Sheet>
    </Box>
  );
}

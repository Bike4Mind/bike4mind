import Box from '@mui/joy/Box';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChildOutcome } from '@shared/agentOutcome';
import type { ChatSessionStatus } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import type { Story, StoryDefault } from '../stories/ladleTypes';
import { SessionBadge } from './SessionBadge';

export default { title: 'Sidebar' } satisfies StoryDefault;

type Row = {
  title: string;
  status: ChatSessionStatus;
  outcome?: ChildOutcome;
  pr?: PrSummary;
  depth?: number;
  selected?: boolean;
};

const ROWS: readonly Row[] = [
  { title: 'Orchestrator (selected, working)', status: 'processing', selected: true },
  { title: 'Child: working', status: 'processing', depth: 1 },
  { title: 'Child: working', status: 'processing', depth: 1 },
  { title: 'Child: needs you', status: 'needs-action', depth: 1 },
  { title: 'Child: failed', status: 'done', outcome: 'failed', depth: 1 },
  { title: 'Child: hit step limit', status: 'done', outcome: 'turn-budget', depth: 1 },
  { title: 'Child: finished', status: 'done', outcome: 'finished', depth: 1 },
  { title: 'Plain chat: idle', status: 'done', outcome: 'finished' },
  { title: 'Chat with open PR', status: 'done', outcome: 'finished', pr: { number: 42, state: 'open' } },
  { title: 'Chat stopped by user', status: 'done', outcome: 'aborted' },
];

/** A stand-in for the sidebar's session list, so every badge state can be seen side by side. */
export const StatusBadges: Story = () => (
  <Box sx={{ width: 300, p: 1, bgcolor: 'background.level1', borderRadius: 'sm' }}>
    <List size="sm" sx={{ '--ListItem-radius': '6px', gap: '2px' }}>
      {ROWS.map((row, index) => (
        <ListItem key={index} sx={{ marginInlineStart: `${(row.depth ?? 0) * 16}px` }}>
          <ListItemButton selected={row.selected}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
              <SessionBadge status={row.status} outcome={row.outcome} pr={row.pr} />
              <Typography level="body-sm">{row.title}</Typography>
            </Stack>
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  </Box>
);

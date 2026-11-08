import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { pendingCallsIn } from '@shared/needsYou';
import { PendingRequests, refreshKeyOf, useSessionMessages } from './AgentPeekDrawer';
import type { AgentView } from './roster';

const slideIn = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
`;

const cardSx = {
  position: 'absolute',
  left: 16,
  bottom: 16,
  zIndex: 200,
  width: 'min(380px, calc(100% - 32px))',
  maxHeight: 'calc(100% - 32px)',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  p: 1.5,
  borderRadius: 'md',
  bgcolor: 'background.surface',
  border: '1px solid',
  borderColor: 'warning.outlinedBorder',
  boxShadow: 'lg',
  animation: `${slideIn} 240ms ease-out`,
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
} as const;

/**
 * What the quiet Tavern shows when someone needs the user: only that request, with its own buttons,
 * so it can be answered from across the room. Pointer input over it leaves the rest of the chrome
 * settled (ambient.ts); `onOpen` is the way to everything else.
 */
export function NeedsYouCard({
  agent,
  name,
  onOpen,
}: {
  /** Undefined when it is the orchestrating conversation itself that is waiting. */
  agent?: AgentView;
  name: string;
  onOpen(): void;
}) {
  return (
    <Box data-testid="orchestrator-needs-you-card" data-ambient-quiet role="status" sx={cardSx}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {`${name} needs you`}
        </Typography>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onOpen}
          data-testid="orchestrator-needs-you-open-btn"
        >
          Open
        </Button>
      </Box>
      {agent ? (
        <AgentRequests agent={agent} />
      ) : (
        <Typography level="body-sm" textColor="text.secondary">
          The Innkeeper is waiting on your answer in the conversation.
        </Typography>
      )}
    </Box>
  );
}

function AgentRequests({ agent }: { agent: AgentView }) {
  const { messages, loadError } = useSessionMessages(agent.id, refreshKeyOf(agent));
  if (loadError) {
    return (
      <Typography level="body-xs" color="danger" data-testid="orchestrator-needs-you-error">
        {loadError}
      </Typography>
    );
  }
  return <PendingRequests calls={pendingCallsIn(messages)} />;
}

import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { finaleStats, formatWallTime } from './finale';
import type { AgentView } from './roster';

const rise = keyframes`
  from { opacity: 0; transform: translate(-50%, -12px); }
  to { opacity: 1; transform: translate(-50%, 0); }
`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function FinaleBanner({
  agents,
  onRead,
  onDismiss,
}: {
  agents: readonly AgentView[];
  onRead(): void;
  onDismiss(): void;
}) {
  const stats = finaleStats(agents);
  const line = [
    plural(stats.agents, 'agent', 'agents'),
    formatWallTime(stats.wallMs),
    stats.cost,
    `${stats.done} done`,
    `${stats.failed} failed`,
  ].join(' \u00B7 ');
  return (
    <Box
      role="status"
      data-testid="orchestrator-finale"
      sx={{
        position: 'absolute',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        // Above the tavern's sprites and door chip.
        zIndex: 200,
        maxWidth: 'calc(100% - 32px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        px: 3,
        py: 2,
        borderRadius: 'md',
        border: '2px solid #2a1d10',
        bgcolor: '#f5c542',
        color: '#2a1d10',
        boxShadow: 'lg',
        animation: `${rise} 0.4s ease-out`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Typography level="title-lg" sx={{ color: 'inherit', fontWeight: 800 }}>
        Quest complete
      </Typography>
      <Typography level="body-sm" data-testid="orchestrator-finale-stats" sx={{ color: 'inherit' }}>
        {line}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button size="sm" color="neutral" variant="solid" data-testid="orchestrator-finale-read-btn" onClick={onRead}>
          Read the report
        </Button>
        <Button
          size="sm"
          color="neutral"
          variant="outlined"
          data-testid="orchestrator-finale-dismiss-btn"
          onClick={onDismiss}
          sx={{ color: 'inherit', borderColor: 'currentColor' }}
        >
          Dismiss
        </Button>
      </Box>
    </Box>
  );
}

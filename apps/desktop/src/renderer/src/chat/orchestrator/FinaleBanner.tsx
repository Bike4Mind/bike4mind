import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { finaleStats, formatWallTime } from './finale';
import type { AgentView } from './roster';
import { INNKEEPER_ART } from './tavern/tavernArt';

const unfurl = keyframes`
  from { opacity: 0; transform: translate(-50%, -16px) scale(0.94); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
`;

// Fixed colours rather than theme tokens: the card sits on the tavern art, which is dark in either app theme.
const INK = '#3b2412';
const INK_SOFT = '#6b4a2b';
const GOLD = '#b8862f';
const PARCHMENT = 'linear-gradient(180deg, #fbf0d4 0%, #f3dfb0 55%, #e8cc92 100%)';
const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function StatChip({ label, alert = false, testId }: { label: string; alert?: boolean; testId?: string }) {
  return (
    <Box
      component="li"
      data-testid={testId}
      sx={{
        px: 1,
        py: 0.25,
        borderRadius: '999px',
        border: '1px solid',
        borderColor: alert ? '#a3392b' : 'rgba(107, 74, 43, 0.45)',
        bgcolor: alert ? '#f6d2c6' : 'rgba(255, 250, 235, 0.6)',
        color: alert ? '#7a1f14' : INK,
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}

/** The "Quest complete" card: a parchment notice pinned over the top of the scene. */
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
  const chips = [
    { key: 'agents', label: plural(stats.agents, 'agent', 'agents') },
    { key: 'time', label: formatWallTime(stats.wallMs) },
    { key: 'cost', label: stats.cost },
    { key: 'done', label: `${stats.done} done` },
    { key: 'failed', label: `${stats.failed} failed`, alert: stats.failed > 0 },
  ];
  return (
    <Box
      role="status"
      aria-label="Quest complete"
      data-testid="orchestrator-finale"
      sx={{
        position: 'absolute',
        top: 'clamp(8px, 2.5%, 24px)',
        left: '50%',
        transform: 'translateX(-50%)',
        // Above the tavern's sprites and door chip.
        zIndex: 200,
        width: 'max-content',
        maxWidth: 'calc(100% - 32px)',
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        pl: 1.25,
        pr: 2,
        py: 1,
        borderRadius: '6px',
        background: PARCHMENT,
        color: INK,
        // A double rule: the gold border plus an inset brown line just inside it.
        border: `4px double ${GOLD}`,
        boxShadow: `inset 0 0 0 1px rgba(107, 74, 43, 0.35), inset 0 0 24px rgba(160, 110, 40, 0.25), 0 10px 28px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)`,
        animation: `${unfurl} 0.45s cubic-bezier(0.2, 0.8, 0.3, 1.2)`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Box
        component="img"
        src={INNKEEPER_ART.cheering}
        alt=""
        draggable={false}
        sx={{
          width: 52,
          height: 52,
          flexShrink: 0,
          objectFit: 'contain',
          imageRendering: 'pixelated',
          borderRadius: '50%',
          border: `2px solid ${GOLD}`,
          bgcolor: '#2a1a0c',
          boxShadow: 'inset 0 0 8px rgba(0, 0, 0, 0.6)',
        }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
        <Typography
          component="h2"
          sx={{
            color: INK,
            fontFamily: SERIF,
            fontSize: '18px',
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: '0.02em',
            m: 0,
          }}
        >
          Quest complete
        </Typography>
        <Box
          component="ul"
          data-testid="orchestrator-finale-stats"
          aria-label="Run summary"
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, listStyle: 'none', m: 0, p: 0 }}
        >
          {chips.map(chip => (
            <StatChip
              key={chip.key}
              label={chip.label}
              alert={chip.alert}
              testId={`orchestrator-finale-stat-${chip.key}`}
            />
          ))}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="sm"
            data-testid="orchestrator-finale-read-btn"
            onClick={onRead}
            sx={{
              bgcolor: INK,
              color: '#fbf0d4',
              fontFamily: SERIF,
              '&:hover': { bgcolor: '#55341a' },
              '&:focus-visible': { outline: `2px solid ${GOLD}`, outlineOffset: 2 },
            }}
          >
            Read the report
          </Button>
          <Button
            size="sm"
            variant="plain"
            data-testid="orchestrator-finale-dismiss-btn"
            onClick={onDismiss}
            sx={{
              color: INK_SOFT,
              fontFamily: SERIF,
              '&:hover': { bgcolor: 'rgba(107, 74, 43, 0.12)', color: INK },
              '&:focus-visible': { outline: `2px solid ${GOLD}`, outlineOffset: 2 },
            }}
          >
            Dismiss
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

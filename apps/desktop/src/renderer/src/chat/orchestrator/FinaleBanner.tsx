import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { finaleStats, formatWallTime, questSucceeded } from './finale';
import type { AgentView } from './roster';
import type { RunSpendView } from './runSpend';
import { INNKEEPER_ART } from './tavern/tavernArt';

const unfurl = keyframes`
  from { opacity: 0; transform: translate(-50%, -16px) scale(0.94); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
`;

const unfurlInline = keyframes`
  from { opacity: 0; transform: translateY(-16px) scale(0.94); }
  to { opacity: 1; transform: translateY(0) scale(1); }
`;

const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const FINALE_LOOKS = ['tavern', 'office'] as const;
export type FinaleLook = (typeof FINALE_LOOKS)[number];
export type FinaleHostArt = { idle: string; cheering: string };

interface Look {
  ink: string;
  inkSoft: string;
  /** The rule colour: `complete`, or `ended` for a quest with failed or unfinished agents. */
  rule: { complete: string; ended: string };
  fontFamily: string;
  title: Record<string, string | number>;
  card: (rule: string) => Record<string, string | number>;
  chip: Record<string, string | number>;
  read: { color: string; hover: string };
  dismissHover: string;
  focus: string;
}

// Fixed colours rather than theme tokens: the card sits on scene art, which is the same in either app theme.
const LOOKS: Record<FinaleLook, Look> = {
  tavern: {
    ink: '#3b2412',
    inkSoft: '#6b4a2b',
    rule: { complete: '#b8862f', ended: '#8a7a66' },
    fontFamily: SERIF,
    title: { fontSize: '18px', letterSpacing: '0.02em' },
    card: rule => ({
      borderRadius: '6px',
      background: 'linear-gradient(180deg, #fbf0d4 0%, #f3dfb0 55%, #e8cc92 100%)',
      // A double rule: the gold border plus an inset brown line just inside it.
      border: `4px double ${rule}`,
      boxShadow:
        'inset 0 0 0 1px rgba(107, 74, 43, 0.35), inset 0 0 24px rgba(160, 110, 40, 0.25), 0 10px 28px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)',
    }),
    chip: { borderRadius: '999px', borderColor: 'rgba(107, 74, 43, 0.45)', bgcolor: 'rgba(255, 250, 235, 0.6)' },
    read: { color: '#fbf0d4', hover: '#55341a' },
    dismissHover: 'rgba(107, 74, 43, 0.12)',
    focus: '#b8862f',
  },
  // A memo pinned up in the Office: flat paper, square corners and the scene's own monospace and greens.
  office: {
    ink: '#27382d',
    inkSoft: '#566654',
    rule: { complete: '#5f8a4f', ended: '#8b8c80' },
    fontFamily: MONO,
    title: { fontSize: '15px', letterSpacing: '0.04em' },
    card: rule => ({
      borderRadius: '2px',
      background: '#f1ecd9',
      border: '2px solid #27382d',
      borderTop: `6px solid ${rule}`,
      boxShadow: '4px 4px 0 rgba(20, 30, 28, 0.5)',
    }),
    chip: { borderRadius: '2px', borderColor: '#9aa790', bgcolor: '#e4e3c9' },
    read: { color: '#f1ecd9', hover: '#3a5142' },
    dismissHover: 'rgba(39, 56, 45, 0.1)',
    focus: '#27382d',
  },
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface FinaleChip {
  key: string;
  label: string;
  alert?: boolean;
}

function StatChip({
  label,
  look,
  alert = false,
  testId,
}: {
  label: string;
  look: Look;
  alert?: boolean;
  testId?: string;
}) {
  return (
    <Box
      component="li"
      data-testid={testId}
      sx={{
        px: 1,
        py: 0.25,
        border: '1px solid',
        ...look.chip,
        ...(alert && { borderColor: '#a3392b', bgcolor: '#f6d2c6' }),
        color: alert ? '#7a1f14' : look.ink,
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

/**
 * The finale card, muted when not every agent finished done. `scene` pins it over the top of the scene art;
 * `inline` sets it in the flow above a Board or Table so it never covers their rows. `spend` is the run's
 * settled total from the server; until it arrives, or when there is none, the card shows the local estimate.
 * `look` dresses it for the scene it sits on, and `hostArt` is that scene's host, the Innkeeper by default.
 */
export function FinaleBanner({
  agents,
  onRead,
  onDismiss,
  placement = 'scene',
  look: lookId = 'tavern',
  hostArt = INNKEEPER_ART,
  title,
  spend,
}: {
  agents: readonly AgentView[];
  spend?: RunSpendView;
  onRead(): void;
  onDismiss(): void;
  placement?: 'scene' | 'inline';
  look?: FinaleLook;
  hostArt?: FinaleHostArt;
  /** The scene's words for a run that finished done, and for one that did not (its copy.stage.finale). */
  title: { complete: string; ended: string };
}) {
  const look = LOOKS[lookId];
  const stats = finaleStats(agents);
  const succeeded = questSucceeded(stats);
  const outcome = succeeded ? 'complete' : 'ended';
  const heading = title[outcome];
  const rule = look.rule[outcome];
  const timing: FinaleChip[] = [
    { key: 'time', label: formatWallTime(stats.wallMs) },
    { key: 'cost', label: spend?.chip ?? stats.cost },
  ];
  // A clean run says so once; the per-outcome counts only earn their chips when they differ.
  const chips: FinaleChip[] = succeeded
    ? [{ key: 'agents', label: stats.agents === 1 ? '1 agent done' : `All ${stats.agents} agents done` }, ...timing]
    : [
        { key: 'agents', label: plural(stats.agents, 'agent', 'agents') },
        ...timing,
        { key: 'done', label: `${stats.done} done` },
        ...(stats.failed > 0 ? [{ key: 'failed', label: `${stats.failed} failed`, alert: true }] : []),
      ];
  return (
    <Box
      role="status"
      aria-label={heading}
      data-testid="orchestrator-finale"
      data-outcome={outcome}
      data-placement={placement}
      data-look={lookId}
      sx={{
        ...(placement === 'scene'
          ? {
              position: 'absolute',
              top: 'clamp(8px, 2.5%, 24px)',
              left: '50%',
              transform: 'translateX(-50%)',
              // Above the scene's sprites and door chip.
              zIndex: 200,
            }
          : { position: 'relative', alignSelf: 'center', flexShrink: 0, mt: 1.5, mb: 0.5 }),
        width: 'max-content',
        maxWidth: 'calc(100% - 32px)',
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        pl: 1.25,
        pr: 2,
        py: 1,
        color: look.ink,
        ...look.card(rule),
        animation: `${placement === 'scene' ? unfurl : unfurlInline} 0.45s cubic-bezier(0.2, 0.8, 0.3, 1.2)`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Box
        component="img"
        src={succeeded ? hostArt.cheering : hostArt.idle}
        alt=""
        draggable={false}
        sx={{
          width: 52,
          height: 52,
          flexShrink: 0,
          objectFit: 'contain',
          imageRendering: 'pixelated',
          ...(lookId === 'office'
            ? { border: `2px solid ${look.ink}`, bgcolor: '#aebbab' }
            : {
                borderRadius: '50%',
                border: `2px solid ${rule}`,
                bgcolor: '#2a1a0c',
                boxShadow: 'inset 0 0 8px rgba(0, 0, 0, 0.6)',
              }),
        }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
        <Typography
          component="h2"
          sx={{
            color: look.ink,
            fontFamily: look.fontFamily,
            fontWeight: 700,
            lineHeight: 1.2,
            m: 0,
            ...look.title,
          }}
        >
          {heading}
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
              look={look}
              alert={chip.alert}
              testId={`orchestrator-finale-stat-${chip.key}`}
            />
          ))}
        </Box>
        {spend && (
          <Box
            component="ul"
            data-testid="orchestrator-finale-spend"
            data-reconciled={spend.reconciled}
            aria-label="Run spend"
            sx={{ m: 0, p: 0, listStyle: 'none', color: look.inkSoft, fontSize: '12px', lineHeight: 1.5 }}
          >
            {spend.lines.map(line => (
              <li key={line}>{line}</li>
            ))}
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="sm"
            data-testid="orchestrator-finale-read-btn"
            onClick={onRead}
            sx={{
              bgcolor: look.ink,
              color: look.read.color,
              fontFamily: look.fontFamily,
              borderRadius: look.chip.borderRadius === '2px' ? '2px' : undefined,
              boxShadow: 'none',
              '&:hover': { bgcolor: look.read.hover },
              '&:active': { boxShadow: 'none' },
              '&:focus-visible': { outline: `2px solid ${look.focus}`, outlineOffset: 2 },
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
              color: look.inkSoft,
              fontFamily: look.fontFamily,
              borderRadius: look.chip.borderRadius === '2px' ? '2px' : undefined,
              '&:hover': { bgcolor: look.dismissHover, color: look.ink },
              '&:focus-visible': { outline: `2px solid ${look.focus}`, outlineOffset: 2 },
            }}
          >
            Dismiss
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

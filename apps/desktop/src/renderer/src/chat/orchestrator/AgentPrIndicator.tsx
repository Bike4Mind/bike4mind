import Box from '@mui/joy/Box';
import type { PrDisplayState } from '@shared/pullRequest';
import type { ViewAgent } from '@shared/viewSnapshot';
import { PR_STATE_LABEL, PrStateIcon } from '../prStateStyle';

function displayState(state: string): PrDisplayState | undefined {
  const normalized = state.toLowerCase();
  switch (normalized) {
    case 'open':
    case 'draft':
    case 'queued':
    case 'merged':
    case 'closed':
      return normalized;
    default:
      return undefined;
  }
}

export function AgentPrIndicator({
  pr,
  onOpen,
  compact = false,
  scene = false,
  testId = 'orchestrator-pr-indicator',
}: {
  pr: ViewAgent['pr'];
  onOpen?(): void;
  compact?: boolean;
  scene?: boolean;
  testId?: string;
}) {
  if (!pr) return null;
  const state = displayState(pr.state);
  const label = `PR #${pr.number} - ${state ? PR_STATE_LABEL[state] : pr.state || 'Unknown'}`;
  return (
    <Box
      component="button"
      type="button"
      aria-haspopup="dialog"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        onOpen?.();
      }}
      onKeyDown={event => event.stopPropagation()}
      data-testid={testId}
      data-pr-number={pr.number}
      title={label}
      aria-label={label}
      sx={{
        display: 'inline-flex',
        cursor: 'pointer',
        fontFamily: 'inherit',
        pointerEvents: 'auto',
        '&:hover': { bgcolor: 'background.level1' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 0.4,
        px: 0.5,
        py: 0.15,
        borderRadius: 'sm',
        bgcolor: 'background.surface',
        color: 'text.secondary',
        border: '1px solid',
        borderColor: 'divider',
        fontSize: scene ? 'clamp(8px, 1.5cqh, 11px)' : 11,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        verticalAlign: 'middle',
        '& svg': { width: '1em', height: '1em' },
      }}
    >
      <PrStateIcon state={state ?? 'draft'} size={12} />
      {`#${pr.number}${compact ? '' : ` ${state ?? (pr.state || 'unknown')}`}`}
    </Box>
  );
}

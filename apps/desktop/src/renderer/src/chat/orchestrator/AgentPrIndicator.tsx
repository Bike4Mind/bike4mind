import { useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Tooltip from '@mui/joy/Tooltip';
import type { PrIconStatus } from '@shared/prAttention';
import type { PrDisplayState } from '@shared/pullRequest';
import type { ViewAgent } from '@shared/viewSnapshot';
import { openInSystemBrowser } from '../prLinks';
import { prHeadline, prPageUrl } from '../prPlainWords';
import { prIconLabel, PrStateIcon } from '../prStateStyle';
import { AgentPrCard } from './AgentPrCard';

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

/** The badge's state as the icon draws it; unknown states fall back to a plain draft glyph. */
function iconStatus(pr: NonNullable<ViewAgent['pr']>): PrIconStatus | undefined {
  const state = displayState(pr.state);
  if (!state) return undefined;
  if (state !== 'open') return { state, ...(pr.stale && { stale: true }) };
  return {
    state,
    ...(pr.attention && { attention: pr.attention }),
    ...(pr.behind && { behind: true }),
    ...(pr.autoMerge && { autoMerge: true }),
    ...(pr.stale && { stale: true }),
  };
}

/** The PR page: from the summary's repo when it has one, else from the monitor's last read. */
async function openPrPage(sessionId: string, pr: NonNullable<ViewAgent['pr']>, known?: string): Promise<void> {
  const url =
    known ?? prPageUrl(pr.repo, pr.number) ?? (await window.b4m.pullRequests.getState(sessionId))?.snapshot?.url;
  if (url) openInSystemBrowser(url);
}

/**
 * An agent's PR badge. A click opens the PR on GitHub in the system browser and a Shift-click the in-app
 * details (`onOpen`); hover or keyboard focus shows AgentPrCard, which spells the state out. Every event
 * stops here so the sprite or row under it does not also select or peek the agent.
 */
export function AgentPrIndicator({
  agentId,
  pr,
  onOpen,
  compact = false,
  scene = false,
  testId = 'orchestrator-pr-indicator',
}: {
  agentId: string;
  pr: ViewAgent['pr'];
  onOpen?(): void;
  compact?: boolean;
  scene?: boolean;
  testId?: string;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  // Joy's Tooltip popper drops its own hover listeners, so the card keeps itself open while pointed at.
  const overCard = useRef(false);
  if (!pr) return null;
  const status = iconStatus(pr);
  const label = status ? prIconLabel(pr.number, status) : `PR #${pr.number} - ${pr.state || 'Unknown'}`;
  const openPage = (known?: string) => {
    overCard.current = false;
    setCardOpen(false);
    void openPrPage(agentId, pr, known).catch(() => undefined);
  };
  return (
    <Tooltip
      open={cardOpen}
      onOpen={() => setCardOpen(true)}
      onClose={() => {
        if (!overCard.current) setCardOpen(false);
      }}
      enterDelay={250}
      enterNextDelay={150}
      // No arrow and a small offset keep the gap the pointer crosses to reach the card short.
      leaveDelay={300}
      placement="top"
      modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}
      variant="outlined"
      // The card holds buttons; the popper root otherwise ignores the pointer.
      sx={{ zIndex: 'popup', p: 1, pointerEvents: 'auto' }}
      title={
        <Box
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onMouseEnter={() => {
            overCard.current = true;
          }}
          onMouseLeave={() => {
            overCard.current = false;
            setCardOpen(false);
          }}
        >
          <AgentPrCard
            sessionId={agentId}
            number={pr.number}
            status={status ?? { state: 'draft' }}
            onOpenPage={openPage}
            onOpenDetails={
              onOpen
                ? () => {
                    overCard.current = false;
                    setCardOpen(false);
                    onOpen();
                  }
                : undefined
            }
          />
        </Box>
      }
    >
      <Box
        component="button"
        type="button"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          // Shift is the keyboard's way to the in-app details, since the card's buttons are not in the tab order.
          if (event.shiftKey && onOpen) {
            setCardOpen(false);
            onOpen();
            return;
          }
          openPage();
        }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') setCardOpen(false);
          if (event.key === 'Enter' && event.shiftKey && onOpen) {
            event.preventDefault();
            setCardOpen(false);
            onOpen();
          }
        }}
        data-testid={testId}
        data-pr-number={pr.number}
        aria-label={`${label}. Opens on GitHub${onOpen ? '; Shift opens details here' : ''}.`}
        sx={{
          position: 'relative',
          display: 'inline-flex',
          cursor: 'pointer',
          fontFamily: 'inherit',
          pointerEvents: 'auto',
          '&:hover': { bgcolor: 'background.level1' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
          // A scene badge is drawn small; this widens what the pointer can hit without growing it.
          ...(scene && { '&::before': { content: '""', position: 'absolute', inset: '-6px -4px' } }),
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
        <PrStateIcon status={status ?? 'draft'} size={12} />
        {`#${pr.number}${compact ? '' : ` ${status ? prHeadline(status).title.toLowerCase() : pr.state || 'unknown'}`}`}
      </Box>
    </Tooltip>
  );
}
